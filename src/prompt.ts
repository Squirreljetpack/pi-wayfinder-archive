export function getWayfinderPromptGuidance(): string {
	return `
## Wayfinder source editing

Explore before reading:
1. Start with get_file_skeleton to map functions, classes, methods, and exports, with line numbers, without reading the whole file.
2. Use get_function next for the specific definitions you need, with their local imports and class context.
3. Use read for narrow line ranges, non-symbol context, small/config files, or when skeleton/function output is insufficient.

Editing:
- Prefer replace_symbol for whole functions, methods, classes, interfaces, or exported const/arrow functions: it replaces the tree-sitter range, doc comment included.
- replace_symbol with text: "" deletes a symbol. It refuses while references survive unless force is true.
- Use insert_symbol to add sibling/helper code next to a named symbol: position 'before' places code above the definition including its doc comment, 'after' below the closing token.
- Use the built-in edit tool for changes smaller than a whole symbol.
- Batch independent changes into one call per tool rather than one call per change.

Symbol navigation:
- Use find_symbol_references to inspect exact AST definitions and references before broad rename work.
- Use rename_symbol for exact symbol renames across files or directories; it renames definitions and references together.
- Tool output lines carry a line-number gutter. The gutter is stripped from replacement text if pasted, but do not add it deliberately.
`;
}
