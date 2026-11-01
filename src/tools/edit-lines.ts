import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AnchorStateManager } from "../anchors/AnchorStateManager.js";
import {
	combineDiffs,
	createUnifiedDiff,
	type DiffDetails,
} from "../rendering/diff-output.js";
import {
	renderCodeLikeCall,
	renderDiffResult,
} from "../rendering/pi-renderers.js";
import { EditLinesSchema } from "./schemas.js";

interface EditLinesFileEdit {
	start_line: number;
	end_line: number;
	new_text: string;
}

interface EditLinesFile {
	path: string;
	edits: EditLinesFileEdit[];
}

interface EditLinesToolDetails {
	files: string[];
	diff: string;
	diffs: DiffDetails[];
	firstChangedLine?: number;
	failures?: Array<{ path?: string; message: string }>;
}

function canonicalTargetKey(absolutePath: string): string {
	const resolvedPath = resolve(absolutePath);
	try {
		return realpathSync.native(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

function detectLineEnding(content: string): "\r\n" | "\n" {
	return content.match(/\r\n|\n/)?.[0] === "\r\n" ? "\r\n" : "\n";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason ?? new Error("edit_lines aborted");
}

function validateLineRange(
	start: number,
	end: number,
	totalLines: number,
): void {
	if (start < 1) throw new Error(`start_line must be at least 1, got ${start}`);
	if (end < start)
		throw new Error(`end_line (${end}) must be >= start_line (${start})`);
	if (start > totalLines)
		throw new Error(
			`start_line ${start} is beyond end of file (${totalLines} lines)`,
		);
	if (end > totalLines)
		throw new Error(
			`end_line ${end} is beyond end of file (${totalLines} lines)`,
		);
}

/**
 * Apply all edits to the original `lines` array at once. Every range is
 * anchored to the original file: line numbers are 1-indexed and inclusive on
 * both ends, and a later edit's range always refers to the pre-edit file, not
 * to the intermediate result of earlier edits. Overlapping ranges are rejected
 * because they are ambiguous under anchored semantics.
 */
export function applyLineEditsAtOnce(
	lines: string[],
	edits: EditLinesFileEdit[],
): string[] {
	const sorted = [...edits].sort((a, b) => a.start_line - b.start_line);

	for (let i = 0; i < sorted.length; i++) {
		const edit = sorted[i];
		validateLineRange(edit.start_line, edit.end_line, lines.length);
		if (i > 0) {
			const prev = sorted[i - 1];
			if (edit.start_line <= prev.end_line) {
				throw new Error(
					`overlapping edits are not allowed: lines ${prev.start_line}-${prev.end_line} overlap lines ${edit.start_line}-${edit.end_line}`,
				);
			}
		}
	}

	const next: string[] = [];
	let cursor = 0; // next original line index to copy; always refers to the original file

	for (const edit of sorted) {
		// copy untouched lines before this edit's range
		next.push(...lines.slice(cursor, edit.start_line - 1));
		const replacementLines =
			edit.new_text === "" ? [] : edit.new_text.split(/\r?\n/);
		next.push(...replacementLines);
		cursor = edit.end_line; // skip the replaced range (end_line is inclusive)
	}

	next.push(...lines.slice(cursor));
	return next;
}

async function withFileMutationQueues<T>(
	canonicalTargetKeys: string[],
	fn: () => Promise<T>,
): Promise<T> {
	const uniqueKeys = Array.from(new Set(canonicalTargetKeys)).sort();

	const runWithQueue = async (index: number): Promise<T> => {
		if (index >= uniqueKeys.length) return fn();
		return withFileMutationQueue(uniqueKeys[index], () =>
			runWithQueue(index + 1),
		);
	};

	return runWithQueue(0);
}

export function registerEditLinesTool(
	pi: ExtensionAPI,
	anchors: AnchorStateManager,
): void {
	pi.registerTool({
		name: "edit_lines",
		label: "Edit File by Line Range",
		description:
			"Replace a line range in a file with new text. Use this for simple line-based edits when anchors are not available (e.g., in replacement mode where the native edit tool is not present). Only use it when you have read the file immediately before the call, so the line numbers are current.",
		promptSnippet:
			"Replace lines in a file by line range for simple edits without anchors.",
		promptGuidelines: [
			"edit_lines is the exception, not the default: prefer edit_file with freshly-read anchors for source edits.",
			"Use edit_lines ONLY when you read the file immediately before the call and take the line numbers from that read's output; never guess line numbers or reuse numbers from an earlier read.",
			"Batch non-overlapping line edits across files in one edit_lines call.",
			"Line numbers are 1-indexed and inclusive on both ends.",
			"All edits in one call are applied at once against the original file: every range is anchored to the pre-edit content, so ranges never shift due to other edits in the same call.",
			"Ranges must not overlap; overlapping ranges are rejected with an error.",
		],
		parameters: EditLinesSchema,
		renderCall(args, theme) {
			const files = Array.isArray(args.files)
				? args.files
						.map((file: EditLinesFile) => file.path)
						.filter((path): path is string => typeof path === "string")
				: [];
			return renderCodeLikeCall("edit_lines", files, theme);
		},
		renderResult(result, options, theme, context) {
			return renderDiffResult(
				result as never,
				options,
				theme,
				context,
				"Editing",
			);
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			const fileTargets = params.files.map((file: EditLinesFile) => {
				const absolutePath = resolve(ctx.cwd, file.path.replace(/^@/, ""));
				return {
					file,
					absolutePath,
					canonicalKey: canonicalTargetKey(absolutePath),
				};
			});
			const seenPaths = new Set<string>();
			for (const { absolutePath, canonicalKey } of fileTargets) {
				if (seenPaths.has(canonicalKey))
					throw new Error(`duplicate edit_lines target path: ${absolutePath}`);
				seenPaths.add(canonicalKey);
			}

			const staged: Array<{
				path: string;
				absolutePath: string;
				nextLines: string[];
				nextContent: string;
				diff: DiffDetails;
				editCount: number;
			}> = [];

			await withFileMutationQueues(
				fileTargets.map((target) => target.canonicalKey),
				async () => {
					const failures: Array<{ path?: string; message: string }> = [];

					for (const { file, absolutePath } of fileTargets) {
						throwIfAborted(signal);

						try {
							const content = await readFile(absolutePath, {
								encoding: "utf8",
								signal,
							});
							throwIfAborted(signal);

							const lineEnding = detectLineEnding(content);
							const lines = content.split(/\r?\n/);

							throwIfAborted(signal);

							const nextLines = applyLineEditsAtOnce(lines, file.edits);

							const nextContent = nextLines.join(lineEnding);
							const diff = createUnifiedDiff(file.path, content, nextContent);

							staged.push({
								path: file.path,
								absolutePath,
								nextLines,
								nextContent,
								diff,
								editCount: file.edits.length,
							});
						} catch (error) {
							throwIfAborted(signal);
							const message =
								error instanceof Error ? error.message : String(error);
							failures.push({
								path: file.path,
								message: `Failed ${file.path}: ${message}`,
							});
						}
					}

					if (failures.length > 0) {
						const error = new Error(
							failures.map((failure) => failure.message).join("\n"),
						);
						(error as Error & { details?: EditLinesToolDetails }).details = {
							files: params.files.map((file: EditLinesFile) => file.path),
							diffs: [],
							diff: "",
							failures,
						};
						throw error;
					}

					for (const item of staged) {
						throwIfAborted(signal);
						await mkdir(dirname(item.absolutePath), { recursive: true });
						throwIfAborted(signal);
						await writeFile(item.absolutePath, item.nextContent, {
							encoding: "utf8",
							signal,
						});
						anchors.reconcile(item.absolutePath, item.nextLines);
					}
				},
			);

			const diffs = staged.map((item) => item.diff).filter((diff) => diff.diff);
			const summaries = staged.map(
				(item) => `Updated ${item.path}: ${item.editCount} line edit(s).`,
			);

			return {
				content: [{ type: "text", text: summaries.join("\n") }],
				details: {
					files: params.files.map((file: EditLinesFile) => file.path),
					diffs,
					diff: combineDiffs(diffs),
					firstChangedLine: diffs[0]?.firstChangedLine,
				} satisfies EditLinesToolDetails,
			};
		},
	});
}
