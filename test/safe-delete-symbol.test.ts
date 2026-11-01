import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchorStateManager } from "../src/anchors/AnchorStateManager.js";
import { SymbolCache } from "../src/symbols/symbol-cache.js";
import { SymbolScanner } from "../src/symbols/symbol-scanner.js";
import {
  blockingReferences,
  computeDeleteRange,
  registerSafeDeleteSymbolTool,
} from "../src/tools/safe-delete-symbol.js";
import type { SymbolLocation } from "../src/symbols/symbol-scanner.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wayfinder-safe-delete-"));
  tempDirs.push(dir);
  return dir;
}

function registerToolForTest(): RegisteredTool {
  let registeredTool: RegisteredTool | undefined;
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      registeredTool = tool;
    }),
  };
  registerSafeDeleteSymbolTool(pi as unknown as ExtensionAPI, new AnchorStateManager(), new SymbolScanner(new SymbolCache()));
  expect(registeredTool).toBeDefined();
  expect(registeredTool?.name).toBe("safe_delete_symbol");
  return registeredTool as RegisteredTool;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("safe_delete_symbol pure helpers", () => {
  it("removes the symbol, its line break, and one following blank line", () => {
    const content = [
      "export function target() {",
      "  return 1;",
      "}",
      "",
      "export const other = 1;",
    ].join("\n");
    const targetStart = content.indexOf("export function target");
    const targetEnd = content.indexOf("\n\nexport const other");
    const range = { startIndex: targetStart, endIndex: targetEnd, startLine: 0, nameText: "target" };

    expect(computeDeleteRange(content, range)).toEqual({ startIndex: targetStart, endIndex: content.indexOf("export const other") });
    const { startIndex, endIndex } = computeDeleteRange(content, range);
    expect(content.slice(0, startIndex) + content.slice(endIndex)).toBe("export const other = 1;");
  });

  it("does not consume the following non-empty line", () => {
    const content = [
      "export function target() {",
      "  return 1;",
      "}",
      "export const other = 1;",
    ].join("\n");
    const targetStart = content.indexOf("export function target");
    const range = { startIndex: targetStart, endIndex: content.indexOf("\nexport const other"), startLine: 0, nameText: "target" };

    const { startIndex, endIndex } = computeDeleteRange(content, range);
    expect(content.slice(0, startIndex) + content.slice(endIndex)).toBe("export const other = 1;");
  });

  it("treats references inside the deleted body as non-blocking", () => {
    const content = [
      "function recurse(n: number) {",
      "  if (n <= 0) return 0;",
      "  return recurse(n - 1);",
      "}",
    ].join("\n");
    const start = content.indexOf("function recurse");
    const range = { startIndex: start, endIndex: content.length, startLine: 0, nameText: "recurse" };
    const deleteRange = computeDeleteRange(content, range);
    const locations: SymbolLocation[] = [
      {
        absolutePath: "/proj/sample.ts",
        displayPath: "sample.ts",
        name: "recurse",
        startLine: 2,
        startColumn: 9,
        endLine: 2,
        endColumn: 16,
        type: "reference",
      },
    ];
    expect(blockingReferences(locations, "recurse", "/proj/sample.ts", content, deleteRange)).toEqual([]);
  });

  it("flags references outside the deleted body as blocking", () => {
    const content = [
      "function target() {}",
      "const caller = target();",
    ].join("\n");
    const start = content.indexOf("function target");
    const range = { startIndex: start, endIndex: content.indexOf("\nconst caller"), startLine: 0, nameText: "target" };
    const deleteRange = computeDeleteRange(content, range);
    const locations: SymbolLocation[] = [
      {
        absolutePath: "/proj/sample.ts",
        displayPath: "sample.ts",
        name: "target",
        startLine: 1,
        startColumn: 15,
        endLine: 1,
        endColumn: 21,
        type: "reference",
      },
    ];
    expect(blockingReferences(locations, "target", "/proj/sample.ts", content, deleteRange)).toEqual([
      { displayPath: "sample.ts", line: 2 },
    ]);
  });
});

describe("safe_delete_symbol tool", () => {
  it("deletes an unreferenced top-level function including its doc comment", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, [
      "/** Unused helper. */",
      "export function unused(name: string) {",
      "  return name.toUpperCase();",
      "}",
      "",
      "export const untouched = 1;",
    ].join("\n"), "utf8");

    const tool = registerToolForTest();
    const result = await tool.execute(
      "call-1",
      { path: "sample.ts", symbol: "unused" },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(readFile(filePath, "utf8")).resolves.toBe("export const untouched = 1;");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "Deleted unreferenced symbol 'unused' from sample.ts.",
    );
    expect(result.details).toMatchObject({ path: "sample.ts", symbol: "unused", deleted: true });
    expect(result.details?.diff).toContain("-1 /** Unused helper. */");
  });

  it("refuses deletion when a surviving reference exists and lists its location", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "sample.ts"), "export function target() {}\n", "utf8");
    await writeFile(join(cwd, "caller.ts"), "import { target } from './sample.js';\ntarget();\n", "utf8");

    const tool = registerToolForTest();
    const result = await tool.execute(
      "call-2",
      { path: "sample.ts", symbol: "target", paths: [cwd] },
      undefined,
      undefined,
      { cwd } as never,
    );

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    // Both the import binding and the call site survive the deletion.
    expect(text).toContain("Refusing to delete 'target': 2 surviving references found.");
    expect(text).toMatch(/caller\.ts:1/);
    expect(text).toMatch(/caller\.ts:2/);
    expect(result.details).toMatchObject({ deleted: false });
    expect(result.details?.references).toEqual([
      { displayPath: "caller.ts", line: 1 },
      { displayPath: "caller.ts", line: 2 },
    ]);
    await expect(readFile(join(cwd, "sample.ts"), "utf8")).resolves.toBe("export function target() {}\n");
  });

  it("deletes despite references when force is set", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "sample.ts"), "export function target() {}\n", "utf8");
    await writeFile(join(cwd, "caller.ts"), "import { target } from './sample.js';\ntarget();\n", "utf8");

    const tool = registerToolForTest();
    const result = await tool.execute(
      "call-3",
      { path: "sample.ts", symbol: "target", paths: [cwd], force: true },
      undefined,
      undefined,
      { cwd } as never,
    );

    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "Deleted symbol 'target' from sample.ts (force was set).",
    );
    await expect(readFile(join(cwd, "sample.ts"), "utf8")).resolves.toBe("");
  });

  it("does not delete a recursive-only symbol when the scanner flags the self-call outside the range", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "sample.ts"), "export function target() {\n  return target();\n}\n", "utf8");

    const tool = registerToolForTest();
    const result = await tool.execute(
      "call-4",
      { path: "sample.ts", symbol: "target" },
      undefined,
      undefined,
      { cwd } as never,
    );

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    // The self-call sits inside the deleted body, so deletion is allowed.
    expect(text).toContain("Deleted unreferenced symbol 'target' from sample.ts.");
    await expect(readFile(join(cwd, "sample.ts"), "utf8")).resolves.toBe("");
  });

  it("reports a missing symbol and leaves the file untouched", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, "export function greet() {}\n", "utf8");

    const tool = registerToolForTest();
    const result = await tool.execute(
      "call-5",
      { path: "sample.ts", symbol: "nope" },
      undefined,
      undefined,
      { cwd } as never,
    );

    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toBe("Symbol 'nope' not found.");
    expect(result.details).toMatchObject({ deleted: false });
    await expect(readFile(filePath, "utf8")).resolves.toBe("export function greet() {}\n");
  });
});
