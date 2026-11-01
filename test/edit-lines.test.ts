import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchorStateManager } from "../src/anchors/AnchorStateManager.js";
import {
  applyLineEditsAtOnce,
  registerEditLinesTool,
} from "../src/tools/edit-lines.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wayfinder-edit-lines-"));
  tempDirs.push(dir);
  return dir;
}

function registerToolForTest(anchors = new AnchorStateManager()): RegisteredTool {
  let registeredTool: RegisteredTool | undefined;
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      registeredTool = tool;
    }),
  };

  registerEditLinesTool(pi as unknown as ExtensionAPI, anchors);

  expect(registeredTool).toBeDefined();
  expect(registeredTool?.name).toBe("edit_lines");
  return registeredTool as RegisteredTool;
}

const LINES = [
  "l1",
  "l2",
  "l3",
  "l4",
  "l5",
  "l6",
  "l7",
  "l8",
  "l9",
  "l10",
];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("applyLineEditsAtOnce", () => {
  it("replaces a single line range", () => {
    const next = applyLineEditsAtOnce(LINES, [
      { start_line: 3, end_line: 5, new_text: "x\ny" },
    ]);

    expect(next).toEqual([
      "l1",
      "l2",
      "x",
      "y",
      "l6",
      "l7",
      "l8",
      "l9",
      "l10",
    ]);
  });

  it("treats every range as anchored to the original file, regardless of input order", () => {
    // Edits are passed in scrambled order on purpose: the result must be the
    // same as applying each range to the original file simultaneously.
    const edits = [
      { start_line: 8, end_line: 9, new_text: "m\nn" }, // grows by 0
      { start_line: 2, end_line: 3, new_text: "a" }, // shrinks by 1
      { start_line: 5, end_line: 5, new_text: "i1\ni2" }, // grows by 1
    ];

    const next = applyLineEditsAtOnce(LINES, edits);

    expect(next).toEqual([
      "l1",
      "a",
      "l4",
      "i1",
      "i2",
      "l6",
      "l7",
      "m",
      "n",
      "l10",
    ]);
  });

  it("does not shift later edits when an earlier edit changes line count", () => {
    // Replacing lines 2-3 with five lines shifts lines below; edit at
    // lines 10-10 must still hit the original line 10.
    const next = applyLineEditsAtOnce(LINES, [
      { start_line: 2, end_line: 3, new_text: "a\nb\nc\nd\ne" },
      { start_line: 10, end_line: 10, new_text: "X" },
    ]);

    expect(next).toEqual([
      "l1",
      "a",
      "b",
      "c",
      "d",
      "e",
      "l4",
      "l5",
      "l6",
      "l7",
      "l8",
      "l9",
      "X",
    ]);
  });

  it("deletes a range when new_text is empty", () => {
    const next = applyLineEditsAtOnce(LINES, [
      { start_line: 4, end_line: 7, new_text: "" },
    ]);

    expect(next).toEqual(["l1", "l2", "l3", "l8", "l9", "l10"]);
  });

  it("splits CRLF replacement text into lines", () => {
    const next = applyLineEditsAtOnce(LINES, [
      { start_line: 1, end_line: 1, new_text: "a\r\nb" },
    ]);

    expect(next).toEqual([
      "a",
      "b",
      "l2",
      "l3",
      "l4",
      "l5",
      "l6",
      "l7",
      "l8",
      "l9",
      "l10",
    ]);
  });

  it("handles adjacent edits without interference", () => {
    const next = applyLineEditsAtOnce(LINES, [
      { start_line: 2, end_line: 2, new_text: "A" },
      { start_line: 3, end_line: 3, new_text: "B" },
    ]);

    expect(next).toEqual([
      "l1",
      "A",
      "B",
      "l4",
      "l5",
      "l6",
      "l7",
      "l8",
      "l9",
      "l10",
    ]);
  });

  it("rejects overlapping edits", () => {
    expect(() =>
      applyLineEditsAtOnce(LINES, [
        { start_line: 5, end_line: 8, new_text: "M" },
        { start_line: 7, end_line: 9, new_text: "N" },
      ]),
    ).toThrow(/overlapping edits are not allowed/);
  });

  it("rejects edits beyond the end of the file", () => {
    expect(() =>
      applyLineEditsAtOnce(LINES, [
        { start_line: 11, end_line: 12, new_text: "x" },
      ]),
    ).toThrow(/beyond end of file/);
  });

  it("rejects start_line below 1", () => {
    expect(() =>
      applyLineEditsAtOnce(LINES, [
        { start_line: 0, end_line: 2, new_text: "x" },
      ]),
    ).toThrow(/start_line must be at least 1/);
  });

  it("rejects end_line below start_line", () => {
    expect(() =>
      applyLineEditsAtOnce(LINES, [
        { start_line: 5, end_line: 4, new_text: "x" },
      ]),
    ).toThrow(/end_line \(4\) must be >= start_line \(5\)/);
  });
});

describe("edit_lines tool", () => {
  it("applies anchored multi-edit batches through the execute path", async () => {
    const cwd = await createTempDir();
    const path = join(cwd, "sample.txt");
    const original = LINES.join("\n") + "\n";
    await writeFile(path, original, "utf8");

    const tool = registerToolForTest();

    await tool.execute(
      "call-1",
      {
        files: [
          {
            path: "sample.txt",
            edits: [
              { start_line: 2, end_line: 3, new_text: "a" },
              { start_line: 5, end_line: 5, new_text: "i1\ni2" },
              { start_line: 10, end_line: 10, new_text: "X" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(readFile(path, "utf8")).resolves.toBe(
      "l1\na\nl4\ni1\ni2\nl6\nl7\nl8\nl9\nX\n",
    );
  });

  it("rejects overlapping edits without writing anything", async () => {
    const cwd = await createTempDir();
    const path = join(cwd, "sample.txt");
    await writeFile(path, LINES.join("\n") + "\n", "utf8");

    const tool = registerToolForTest();

    await expect(
      tool.execute(
        "call-2",
        {
          files: [
            {
              path: "sample.txt",
              edits: [
                { start_line: 5, end_line: 8, new_text: "M" },
                { start_line: 7, end_line: 9, new_text: "N" },
              ],
            },
          ],
        },
        undefined,
        undefined,
        { cwd } as never,
      ),
    ).rejects.toThrow(/overlapping edits are not allowed/);

    await expect(readFile(path, "utf8")).resolves.toBe(
      LINES.join("\n") + "\n",
    );
  });

  it("preserves CRLF line endings when applying anchored edits", async () => {
    const cwd = await createTempDir();
    const path = join(cwd, "crlf.txt");
    await writeFile(path, "alpha\r\nbeta\r\ngamma\r\n", "utf8");

    const tool = registerToolForTest();

    await tool.execute(
      "call-3",
      {
        files: [
          {
            path: "crlf.txt",
            edits: [
              { start_line: 2, end_line: 2, new_text: "BETA" },
              { start_line: 3, end_line: 3, new_text: "delta\ne" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      { cwd } as never,
    );

    await expect(readFile(path, "utf8")).resolves.toBe(
      "alpha\r\nBETA\r\ndelta\r\ne\r\n",
    );
  });
});
