import { Type } from "typebox";

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
			force: Type.Optional(
				Type.Boolean({
					description:
						"Delete even when references to the symbol survive (text: \"\" only)",
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
