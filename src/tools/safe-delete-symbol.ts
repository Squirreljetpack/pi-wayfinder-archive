import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AnchorStateManager } from "../anchors/AnchorStateManager.js";
import { ASTAnchorBridge, type SymbolRange } from "../ast/ast-anchor-bridge.js";
import { combineDiffs, createUnifiedDiff, type DiffDetails } from "../rendering/diff-output.js";
import { renderCodeLikeCall, renderDiffResult } from "../rendering/pi-renderers.js";
import type { SymbolLocation, SymbolScanner } from "../symbols/symbol-scanner.js";
import { SafeDeleteSymbolSchema } from "./schemas.js";

export interface DeleteRange {
  startIndex: number;
  endIndex: number;
}

interface SafeDeleteSymbolToolDetails {
  path: string;
  symbol: string;
  deleted: boolean;
  references?: Array<{ displayPath: string; line: number }>;
  diff?: string;
  diffs?: DiffDetails[];
  firstChangedLine?: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("safe_delete_symbol aborted");
}

function missingSymbolMessage(symbol: string, type: string | undefined): string {
  return `Symbol '${symbol}'${type ? ` of type '${type}'` : ""} not found.`;
}

/**
 * Computes the byte range to remove for a symbol.
 *
 * `range.startIndex` is clamped to the start of the symbol's first line (doc
 * comments included). The removal extends through the end of the symbol's last
 * line plus its line break, and consumes one following empty line so the
 * deletion does not leave a dangling blank line behind.
 */
export function computeDeleteRange(content: string, range: SymbolRange): DeleteRange {
  const startIndex = range.startIndex;

  let lineBreak = content.indexOf("\n", range.endIndex);
  if (lineBreak === -1) lineBreak = content.length;

  // Trim trailing spaces/tabs on the symbol's final line.
  let trimmedEnd = lineBreak;
  while (trimmedEnd > range.endIndex && (content[trimmedEnd - 1] === " " || content[trimmedEnd - 1] === "\t")) {
    trimmedEnd--;
  }

  // Include the line break (and the \r of \r\n, which sits right before \n).
  let endIndex = lineBreak === content.length ? trimmedEnd : lineBreak + 1;

  // Consume one following blank (whitespace-only) line, if present, so the
  // deletion does not leave a dangling empty line behind.
  let probe = endIndex;
  while (probe < content.length && (content[probe] === " " || content[probe] === "\t")) probe++;
  if (probe < content.length && content[probe] === "\n") {
    endIndex = probe + 1;
  } else if (probe < content.length && content[probe] === "\r" && content[probe + 1] === "\n") {
    endIndex = probe + 2;
  }

  return { startIndex, endIndex };
}

function offsetAt(content: string, lines: string[], line: number, column: number): number {
  if (line <= 0) return Math.min(column, content.length);
  const preceding = lines.slice(0, line).join("\n");
  return Math.min(preceding.length + 1 + column, content.length);
}

/**
 * Returns references that would survive the deletion — i.e. references outside
 * the removed byte range. References inside the symbol's own body disappear
 * with it, so they do not block deletion.
 */
export function blockingReferences(
  locations: SymbolLocation[],
  symbol: string,
  absolutePath: string,
  content: string,
  deleteRange: DeleteRange,
): Array<{ displayPath: string; line: number }> {
  const lines = content.split(/\r?\n/);
  const blockers: Array<{ displayPath: string; line: number }> = [];

  for (const location of locations) {
    if (location.name !== symbol || location.type !== "reference") continue;
    const offset = offsetAt(content, lines, location.startLine, location.startColumn);
    if (location.absolutePath === absolutePath && offset >= deleteRange.startIndex && offset < deleteRange.endIndex) {
      continue; // inside the deleted body — removed along with the symbol
    }
    blockers.push({ displayPath: location.displayPath, line: location.startLine + 1 });
  }

  return blockers;
}

export function registerSafeDeleteSymbolTool(pi: ExtensionAPI, anchors: AnchorStateManager, scanner: SymbolScanner): void {
  pi.registerTool({
    name: "safe_delete_symbol",
    label: "Safe Delete Symbol",
    description: "Delete a named AST symbol definition only when it has no surviving references.",
    promptSnippet: "Safely delete an unreferenced symbol definition.",
    promptGuidelines: [
      "Use safe_delete_symbol to delete a whole symbol (including its doc comment) without leaving dangling references.",
      "The tool scans for references and refuses to delete when surviving references exist; pass force=true only when you have verified the call sites yourself.",
      "References inside the deleted symbol's own body do not block deletion.",
    ],
    parameters: SafeDeleteSymbolSchema,
    renderCall(args, theme) {
      const paths = typeof args.path === "string" ? [args.path] : [];
      const suffix = typeof args.symbol === "string" ? theme.fg("dim", ` (${args.symbol})`) : "";
      return renderCodeLikeCall("safe_delete_symbol", paths, theme, suffix);
    },
    renderResult(result, options, theme, context) {
      return renderDiffResult(result as never, options, theme, context, "Deleting");
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = params.path as unknown;
      const symbol = params.symbol as unknown;
      if (typeof path !== "string" || path.length === 0) throw new Error("Missing required parameter: path");
      if (typeof symbol !== "string" || symbol.length === 0) throw new Error("Missing required parameter: symbol");
      const type = params.type as string | undefined;
      const force = params.force === true;
      const scanPaths = Array.isArray(params.paths) && params.paths.length > 0 ? params.paths : [ctx.cwd];

      const cleanedPath = path.replace(/^@/, "");
      const absolutePath = cleanedPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(cleanedPath)
        ? cleanedPath
        : resolve(ctx.cwd, cleanedPath);

      throwIfAborted(signal);
      const originalContent = await readFile(absolutePath, { encoding: "utf8", signal });
      const range = await ASTAnchorBridge.getSymbolRange(absolutePath, symbol, anchors, type);
      if (!range) {
        return {
          content: [{ type: "text", text: missingSymbolMessage(symbol, type) }],
          details: { path, symbol, deleted: false } satisfies SafeDeleteSymbolToolDetails,
        };
      }

      const deleteRange = computeDeleteRange(originalContent, range);
      const finalContent = originalContent.slice(0, deleteRange.startIndex) + originalContent.slice(deleteRange.endIndex);

      if (!force) {
        const locations = await scanner.scanPaths(scanPaths, ctx.cwd, signal);
        const blockers = blockingReferences(locations, symbol, absolutePath, originalContent, deleteRange);
        if (blockers.length > 0) {
          const list = blockers.map((ref) => `  ${ref.displayPath}:${ref.line}`).join("\n");
          const fileLabel = blockers.length === 1 ? "reference" : "references";
          return {
            content: [{
              type: "text",
              text: `Refusing to delete '${symbol}': ${blockers.length} surviving ${fileLabel} found.\n${list}\n\nVerify the call sites, or pass force=true to delete anyway.`,
            }],
            details: { path, symbol, deleted: false, references: blockers } satisfies SafeDeleteSymbolToolDetails,
          };
        }
      }

      throwIfAborted(signal);
      const finalLines = finalContent.split(/\r?\n/);
      const diff = createUnifiedDiff(path, originalContent, finalContent);

      await withFileMutationQueue(absolutePath, async () => {
        throwIfAborted(signal);
        await writeFile(absolutePath, finalContent, { encoding: "utf8", signal });
        anchors.reconcile(absolutePath, finalLines);
        scanner.invalidate(absolutePath);
      });

      const summary = force ? `Deleted symbol '${symbol}' from ${path} (force was set).` : `Deleted unreferenced symbol '${symbol}' from ${path}.`;
      return {
        content: [{ type: "text", text: summary }],
        details: {
          path,
          symbol,
          deleted: true,
          diffs: [diff],
          diff: combineDiffs([diff]),
          firstChangedLine: diff.firstChangedLine,
        } satisfies SafeDeleteSymbolToolDetails,
      };
    },
  });
}
