import { Type } from "typebox";

export const ReadFileSchema = Type.Object({
	paths: Type.Array(Type.String(), {
		description:
			"Relative or absolute file paths to read. A path may include an inline range suffix like src/file.ts:10-50 or src/file.ts:100.",
	}),
	start_line: Type.Optional(
		Type.Integer({ minimum: 1, description: "1-indexed start line" }),
	),
	end_line: Type.Optional(
		Type.Integer({ minimum: 1, description: "1-indexed end line, inclusive" }),
	),
});

export const EditFileSchema = Type.Object({
	files: Type.Array(
		Type.Object({
			path: Type.String({
				description: "Relative or absolute source file path",
			}),
			edits: Type.Array(
				Type.Object({
					edit_type: Type.Union(
						[
							Type.Literal("replace"),
							Type.Literal("replace_range"),
							Type.Literal("insert_after"),
							Type.Literal("insert_before"),
						],
						{ description: "Edit operation type" },
					),
					anchor: Type.String({
						description:
							"The single-line start anchor (e.g. AnchorWord│line content). Strongly prefer using single-line anchor + end_anchor for multi-line replacements.",
					}),
					end_anchor: Type.Optional(
						Type.String({
							description:
								"The single-line end anchor for range replacements. Strongly preferred when replacing multiple lines.",
						}),
					),
					text: Type.String({
						description: "Replacement or inserted code (without anchors)",
					}),
				}),
			),
		}),
	),
});

export const EditLinesSchema = Type.Object({
	files: Type.Array(
		Type.Object({
			path: Type.String({
				description: "Relative or absolute source file path",
			}),
			edits: Type.Array(
				Type.Object({
					start_line: Type.Integer({
						minimum: 1,
						description: "1-indexed start line",
					}),
					end_line: Type.Integer({
						minimum: 1,
						description: "1-indexed end line, inclusive",
					}),
					new_text: Type.String({
						description: "Replacement text for the line range",
					}),
				}),
			),
		}),
	),
});

export const GetFileSkeletonSchema = Type.Object({
	paths: Type.Array(
		Type.String({ description: "Relative or absolute source file paths" }),
	),
});

export const GetFunctionSchema = Type.Object({
	paths: Type.Array(
		Type.String({ description: "Relative or absolute source file paths" }),
	),
	function_names: Type.Array(
		Type.String({ description: "Function, class, or method names to read" }),
	),
});

export const ReplaceSymbolSchema = Type.Object({
	replacements: Type.Array(
		Type.Object({
			path: Type.String({
				description: "Relative or absolute source file path",
			}),
			symbol: Type.String({
				description: "Dot-separated symbol path or suffix to replace",
			}),
			text: Type.String({
				description: "Complete replacement source for the symbol",
			}),
			type: Type.Optional(
				Type.String({
					description:
						"Optional symbol type such as function, method, class, or interface",
				}),
			),
		}),
	),
});

export const InsertSymbolSchema = Type.Object({
	insertions: Type.Array(
		Type.Object({
			path: Type.String({
				description: "Relative or absolute source file path",
			}),
			symbol: Type.String({
				description:
					"Dot-separated symbol path or suffix to insert adjacent to",
			}),
			position: Type.Union([Type.Literal("before"), Type.Literal("after")], {
				description: "Insert before or after the symbol definition",
			}),
			text: Type.String({ description: "Code to insert" }),
			type: Type.Optional(
				Type.String({
					description:
						"Optional symbol type such as function, method, class, or interface",
				}),
			),
		}),
	),
});

export const SafeDeleteSymbolSchema = Type.Object({
	path: Type.String({
		description: "Relative or absolute source file path containing the symbol",
	}),
	symbol: Type.String({
		description: "Dot-separated symbol path or suffix to delete",
	}),
	type: Type.Optional(
		Type.String({
			description:
				"Optional symbol type such as function, method, class, or interface",
		}),
	),
	paths: Type.Optional(
		Type.Array(
			Type.String({
				description:
					"Files/directories to scan for references (default: project root)",
			}),
		),
	),
	force: Type.Optional(
		Type.Boolean({
			description: "Delete even if references exist (default: false)",
		}),
	),
});

export const FindSymbolReferencesSchema = Type.Object({
	paths: Type.Array(
		Type.String({
			description: "Relative or absolute files/directories to search",
		}),
	),
	symbols: Type.Array(
		Type.String({ description: "Exact symbol names to find" }),
	),
	find_type: Type.Optional(
		Type.Union([
			Type.Literal("definition"),
			Type.Literal("reference"),
			Type.Literal("both"),
		]),
	),
});

export const RenameSymbolSchema = Type.Object({
	paths: Type.Array(
		Type.String({
			description: "Relative or absolute files/directories to rename within",
		}),
	),
	existing_symbol: Type.String({ description: "Exact symbol text to rename" }),
	new_symbol: Type.String({ description: "Replacement symbol text" }),
});
