import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchorStateManager } from "../src/anchors/AnchorStateManager.js";
import { formatLineWithHash } from "../src/anchors/line-hashing.js";
import {
  applyAnchoredEdits,
  registerEditFileTool,
  type EditOperation
} from "../src/tools/edit-file.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wayfinder-edit-file-"));
  tempDirs.push(dir);
  return dir;
}

function registerToolForTest(anchors = new AnchorStateManager()): RegisteredTool {
  let registeredTool: RegisteredTool | undefined;
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      registeredTool = tool;
    })
  };

  registerEditFileTool(pi as unknown as ExtensionAPI, anchors);

  expect(registeredTool).toBeDefined();
  expect(registeredTool?.name).toBe("edit_file");
  return registeredTool as RegisteredTool;
}

function anchorsFor(lines: string[]): string[] {
  return new AnchorStateManager().reconcile("/tmp/a.txt", lines);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("applyAnchoredEdits", () => {
  it("applies replace, insert_before, and insert_after edits", () => {
    const lines = ["one", "two", "three"];
    const anchors = anchorsFor(lines);

    const next = applyAnchoredEdits(lines, anchors, [
      {
        edit_type: "replace",
        anchor: formatLineWithHash("two", anchors[1]),
        end_anchor: formatLineWithHash("two", anchors[1]),
        text: "TWO"
      },
      { edit_type: "insert_before", anchor: formatLineWithHash("one", anchors[0]), text: "zero" },
      { edit_type: "insert_after", anchor: formatLineWithHash("three", anchors[2]), text: "four" }
    ]);

    expect(next).toEqual(["zero", "one", "TWO", "three", "four"]);
  });


  it("defaults replace end_anchor to the start anchor", () => {
    const lines = ["one", "two", "three"];
    const anchors = anchorsFor(lines);

    const next = applyAnchoredEdits(lines, anchors, [
      {
        edit_type: "replace",
        anchor: formatLineWithHash("two", anchors[1]),
        text: "TWO"
      }
    ]);

    expect(next).toEqual(["one", "TWO", "three"]);
  });

  it("rejects stale anchor content", () => {
    const lines = ["one", "two"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: formatLineWithHash("wrong", anchors[0]),
          end_anchor: formatLineWithHash("one", anchors[0]),
          text: "ONE"
        }
      ])
    ).toThrow(/content mismatch/);
  });

  it("reports stale anchor mismatches with line numbers and both contents", () => {
    const lines = ["alpha", "beta", "gamma"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: formatLineWithHash("old beta", anchors[1]),
          text: "BETA"
        }
      ])
    ).toThrow(
      'anchor content mismatch at line 2; current "beta", requested "old beta"'
    );
  });

  it("reports missing anchors with the anchor name", () => {
    const lines = ["alpha", "beta"];

    expect(() =>
      applyAnchoredEdits(lines, ["WayA", "WayB"], [
        {
          edit_type: "replace",
          anchor: "WayMissing│beta",
          text: "BETA"
        }
      ])
    ).toThrow('anchor not found; requested "beta"');
  });

  it("explains that anchor words must be registered hash tokens", () => {
    const lines = ["alpha", "beta"];

    expect(() =>
      applyAnchoredEdits(lines, ["WayA", "WayB"], [
        {
          edit_type: "replace",
          anchor: "D9doc│beta",
          text: "BETA"
        }
      ])
    ).toThrow(
      /invalid hash format \"D9doc\".*hash token registered for this file.*read_file \/ get_file_skeleton \/ get_function/
    );
  });

  it("suggests the correct anchor when the content matches a line", () => {
    const lines = ["alpha", "beta"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: "WayZ│beta",
          text: "BETA"
        }
      ])
    ).toThrow('anchor not found; requested "beta"; did you mean WayB');
  });

  it("suggests the correct anchor on content mismatch", () => {
    const lines = ["alpha", "beta"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: formatLineWithHash("beta", anchors[0]),
          text: "BETA"
        }
      ])
    ).toThrow(
      'anchor content mismatch at line 1; current "alpha", requested "beta"; did you mean WayB'
    );
  });

  it("suggests the correct anchor on invalid hash format", () => {
    const lines = ["alpha", "beta"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: "D9doc│beta",
          text: "BETA"
        }
      ])
    ).toThrow(/invalid hash format "D9doc".*not a made-up word; did you mean WayB/);
  });

  it("lists all matching anchors for duplicate lines", () => {
    const lines = ["dup", "dup", "other"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: "WayZ│dup",
          text: "DUP"
        }
      ])
    ).toThrow('anchor not found; requested "dup"; did you mean one of WayA, WayB');
  });

  it("omits the did-you-mean hint when no line matches", () => {
    const lines = ["alpha", "beta"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: "WayZ│gamma",
          text: "GAMMA"
        }
      ])
    ).toThrow('anchor not found; requested "gamma"');
  });

  it("rejects overlapping edits", () => {
    const lines = ["one", "two", "three"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: formatLineWithHash("one", anchors[0]),
          end_anchor: formatLineWithHash("two", anchors[1]),
          text: "ONE\nTWO"
        },
        {
          edit_type: "replace",
          anchor: formatLineWithHash("two", anchors[1]),
          end_anchor: formatLineWithHash("three", anchors[2]),
          text: "TWO\nTHREE"
        }
      ])
    ).toThrow(/overlapping edits/);
  });

  it("deletes a replace range when text is empty", () => {
    const lines = ["one", "two", "three"];
    const anchors = anchorsFor(lines);

    const next = applyAnchoredEdits(lines, anchors, [
      {
        edit_type: "replace",
        anchor: formatLineWithHash("two", anchors[1]),
        end_anchor: formatLineWithHash("two", anchors[1]),
        text: ""
      }
    ]);

    expect(next).toEqual(["one", "three"]);
  });

  it("strips anchors from replacement text before applying edits", () => {
    const lines = ["one", "two"];
    const anchors = anchorsFor(lines);

    const next = applyAnchoredEdits(lines, anchors, [
      {
        edit_type: "replace",
        anchor: formatLineWithHash("two", anchors[1]),
        end_anchor: formatLineWithHash("two", anchors[1]),
        text: `${anchors[1]}│TWO`
      }
    ]);

    expect(next).toEqual(["one", "TWO"]);
  });

  it("treats replace_range as replace for anchored ranges", () => {
    const lines = ["one", "two", "three", "four"];
    const anchors = anchorsFor(lines);

    const next = applyAnchoredEdits(lines, anchors, [
      {
        edit_type: "replace_range",
        anchor: formatLineWithHash("two", anchors[1]),
        end_anchor: formatLineWithHash("three", anchors[2]),
        text: "TWO\nTHREE"
      }
    ]);

    expect(next).toEqual(["one", "TWO", "THREE", "four"]);
  });

  it("strips WayXX│ prefix from anchor content before comparison", () => {
    const lines = ["first line of content"];
    const anchors = anchorsFor(lines);

    // Anchor content has a WayXX│ prefix that should be stripped before comparison
    const next = applyAnchoredEdits(lines, anchors, [
      {
        edit_type: "replace",
        anchor: `${anchors[0]}│first line of content`,
        text: "REPLACED"
      }
    ]);

    expect(next).toEqual(["REPLACED"]);
  });

  it("falls back to whitespace-insensitive matching when exact anchor fails", () => {
    const lines = ["const value = 1;"];
    const anchors = anchorsFor(lines);

    const next = applyAnchoredEdits(lines, anchors, [
      {
        edit_type: "replace",
        anchor: `${anchors[0]}│const  value   = 1;`,
        text: "const value = 2;"
      }
    ]);

    expect(next).toEqual(["const value = 2;"]);
  });

  it("rejects ambiguous whitespace-insensitive anchor matches", () => {
    const lines = ["alpha", "beta"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: "WayMissing│alpha",
          text: "ALPHA"
        }
      ])
    ).toThrow(/anchor not found/);
  });
});

describe("multi-line anchors", () => {
  it("rejects multi-line anchors and returns correct tool call for valid way-marked replacement", () => {
    const lines = ["one", "two", "three", "four"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(
        lines,
        anchors,
        [
          {
            edit_type: "replace",
            anchor:
              [
                formatLineWithHash("two", anchors[1]),
                formatLineWithHash("three", anchors[2])
              ].join("\n") + "\n",
            text: "TWO\nTHREE"
          }
        ],
        "sample.ts"
      )
    ).toThrow(
      new RegExp(
        "multi-line anchors are not supported directly; use single-line anchor with end_anchor\\. Correct tool call:\\s*" +
          JSON.stringify(
            {
              files: [
                {
                  path: "sample.ts",
                  edits: [
                    {
                      edit_type: "replace",
                      anchor: formatLineWithHash("two", anchors[1]),
                      end_anchor: formatLineWithHash("three", anchors[2]),
                      text: "TWO\nTHREE"
                    }
                  ]
                }
              ]
            },
            null,
            2
          ).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      )
    );
  });

  it("returns correct tool call for valid raw text multi-line replacement without way markers", () => {
    const lines = ["alpha", "beta", "gamma"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(
        lines,
        anchors,
        [
          {
            edit_type: "replace",
            anchor: "alpha\nbeta",
            text: "ALPHA_BETA"
          }
        ],
        "foo.ts"
      )
    ).toThrow(
      new RegExp(
        "multi-line anchors are not supported directly; use single-line anchor with end_anchor\\. Correct tool call:\\s*" +
          JSON.stringify(
            {
              files: [
                {
                  path: "foo.ts",
                  edits: [
                    {
                      edit_type: "replace",
                      anchor: formatLineWithHash("alpha", anchors[0]),
                      end_anchor: formatLineWithHash("beta", anchors[1]),
                      text: "ALPHA_BETA"
                    }
                  ]
                }
              ]
            },
            null,
            2
          ).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      )
    );
  });

  it("elides text content > 500 chars in the returned tool call format", () => {
    const lines = ["alpha", "beta", "gamma"];
    const anchors = anchorsFor(lines);
    const longText = "x".repeat(501);

    expect(() =>
      applyAnchoredEdits(
        lines,
        anchors,
        [
          {
            edit_type: "replace",
            anchor: "alpha\nbeta",
            text: longText
          }
        ],
        "bar.ts"
      )
    ).toThrow(
      new RegExp(
        "multi-line anchors are not supported directly; use single-line anchor with end_anchor\\. Correct tool call:\\s*" +
          JSON.stringify(
            {
              files: [
                {
                  path: "bar.ts",
                  edits: [
                    {
                      edit_type: "replace",
                      anchor: formatLineWithHash("alpha", anchors[0]),
                      end_anchor: formatLineWithHash("beta", anchors[1]),
                      text: "<elided>"
                    }
                  ]
                }
              ]
            },
            null,
            2
          ).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      )
    );
  });

  it("does not include tool call format when raw content is not unique in file", () => {
    const lines = ["dup", "dup", "other", "dup", "dup"];
    const anchors = anchorsFor(lines);

    let thrownMessage = "";
    try {
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: "dup\ndup",
          text: "DUP"
        }
      ]);
    } catch (err: any) {
      thrownMessage = err.message;
    }

    expect(thrownMessage).toContain("multi-line anchors are not supported directly; use a single-line anchor with end_anchor to delimit the range end");
    expect(thrownMessage).not.toContain("Correct tool call:");
  });

  it("does not include tool call format when way markers are mixed (some anchored, some raw)", () => {
    const lines = ["alpha", "beta", "gamma"];
    const anchors = anchorsFor(lines);

    let thrownMessage = "";
    try {
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: `${formatLineWithHash("alpha", anchors[0])}\nbeta`,
          text: "ALPHA"
        }
      ]);
    } catch (err: any) {
      thrownMessage = err.message;
    }

    expect(thrownMessage).toContain("multi-line anchors are not supported directly; use a single-line anchor with end_anchor to delimit the range end");
    expect(thrownMessage).not.toContain("Correct tool call:");
  });

  it("does not include tool call format when way markers do not match registered anchors", () => {
    const lines = ["alpha", "beta", "gamma", "delta"];
    const anchors = anchorsFor(lines);

    let thrownMessage = "";
    try {
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: [
            formatLineWithHash("alpha", anchors[0]),
            formatLineWithHash("gamma", anchors[2])
          ].join("\n"),
          text: "ALPHA"
        }
      ]);
    } catch (err: any) {
      thrownMessage = err.message;
    }

    expect(thrownMessage).toContain("multi-line anchors are not supported directly; use a single-line anchor with end_anchor to delimit the range end");
    expect(thrownMessage).not.toContain("Correct tool call:");
  });

  it("rejects multi-line end_anchor with explicit single-line error", () => {
    const lines = ["one", "two", "three"];
    const anchors = anchorsFor(lines);

    expect(() =>
      applyAnchoredEdits(lines, anchors, [
        {
          edit_type: "replace",
          anchor: formatLineWithHash("one", anchors[0]),
          end_anchor: `${formatLineWithHash("two", anchors[1])}\n${formatLineWithHash("three", anchors[2])}`,
          text: "REPLACEMENT"
        }
      ])
    ).toThrow("end_anchor must be a single-line anchor; use a single-line end_anchor to delimit the range end");
  });

  it("normalizes multi-line anchors in every edit of the corrected tool call", () => {
    const linesA = ["one", "two", "three", "four"];
    const anchorsA = anchorsFor(linesA);
    const linesB = ["alpha", "beta", "gamma"];
    const anchorsB = anchorsFor(linesB);

    const files: { path: string; edits: EditOperation[] }[] = [
      {
        path: "a.ts",
        edits: [
          {
            edit_type: "replace",
            anchor: formatLineWithHash("one", anchorsA[0]),
            text: "ONE"
          }
        ]
      },
      {
        path: "b.ts",
        edits: [
          {
            edit_type: "replace",
            anchor: `${formatLineWithHash("alpha", anchorsB[0])}\n${formatLineWithHash("beta", anchorsB[1])}`,
            text: "ALPHA_BETA"
          },
          {
            edit_type: "insert_before",
            anchor: `${formatLineWithHash("gamma", anchorsB[2])}\n${formatLineWithHash("beta", anchorsB[1])}`,
            text: "INS"
          }
        ]
      },
      {
        path: "c.ts",
        edits: [
          {
            edit_type: "replace",
            anchor: `${formatLineWithHash("two", anchorsA[1])}\n${formatLineWithHash("three", anchorsA[2])}`,
            text: "TWO_THREE"
          }
        ]
      }
    ];

    expect(() =>
      applyAnchoredEdits(linesB, anchorsB, files[1].edits, "b.ts", files)
    ).toThrow(
      new RegExp(
        "multi-line anchors are not supported directly; use single-line anchor with end_anchor\\. Correct tool call:\\s*" +
          JSON.stringify(
            {
              files: [
                files[0],
                {
                  path: "b.ts",
                  edits: [
                    {
                      edit_type: "replace",
                      anchor: formatLineWithHash("alpha", anchorsB[0]),
                      end_anchor: formatLineWithHash("beta", anchorsB[1]),
                      text: "ALPHA_BETA"
                    },
                    {
                      edit_type: "insert_before",
                      anchor: formatLineWithHash("gamma", anchorsB[2]),
                      text: "INS"
                    }
                  ]
                },
                {
                  path: "c.ts",
                  edits: [
                    {
                      edit_type: "replace",
                      anchor: formatLineWithHash("two", anchorsA[1]),
                      text: "TWO_THREE",
                      end_anchor: formatLineWithHash("three", anchorsA[2])
                    }
                  ]
                }
              ]
            },
            null,
            2
          ).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      )
    );
  });

  it("keeps single-line anchors unchanged and fixes multi-line end_anchor in non-target edits", () => {
    const linesB = ["alpha", "beta", "gamma"];
    const anchorsB = anchorsFor(linesB);

    const files: { path: string; edits: EditOperation[] }[] = [
      {
        path: "b.ts",
        edits: [
          {
            edit_type: "replace",
            anchor: `${formatLineWithHash("alpha", anchorsB[0])}\n${formatLineWithHash("beta", anchorsB[1])}`,
            text: "ALPHA_BETA"
          },
          {
            edit_type: "replace",
            anchor: formatLineWithHash("gamma", anchorsB[2]),
            end_anchor: `${formatLineWithHash("beta", anchorsB[1])}\n${formatLineWithHash("alpha", anchorsB[0])}`,
            text: "GAMMA"
          }
        ]
      }
    ];

    expect(() =>
      applyAnchoredEdits(linesB, anchorsB, files[0].edits, "b.ts", files)
    ).toThrow(
      new RegExp(
        "multi-line anchors are not supported directly; use single-line anchor with end_anchor\\. Correct tool call:\\s*" +
          JSON.stringify(
            {
              files: [
                {
                  path: "b.ts",
                  edits: [
                    {
                      edit_type: "replace",
                      anchor: formatLineWithHash("alpha", anchorsB[0]),
                      end_anchor: formatLineWithHash("beta", anchorsB[1]),
                      text: "ALPHA_BETA"
                    },
                    {
                      edit_type: "replace",
                      anchor: formatLineWithHash("gamma", anchorsB[2]),
                      end_anchor: formatLineWithHash("beta", anchorsB[1]),
                      text: "GAMMA"
                    }
                  ]
                }
              ]
            },
            null,
            2
          ).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      )
    );
  });

});

describe("edit_file schema", () => {
  it("accepts replace_range as an alias for replace", () => {
    const tool = registerToolForTest();
    const editType = (((tool.parameters as { properties: { files: { items: { properties: { edits: { items: { properties: { edit_type: { anyOf: Array<{ const: string }> } } } } } } } } }).properties.files.items.properties.edits.items.properties.edit_type.anyOf));

    expect(editType.map((item) => item.const)).toContain("replace_range");
  });
});


describe("edit_file tool", () => {
  it("preserves CRLF line endings when applying edits", async () => {
    const cwd = await createTempDir();
    const path = join(cwd, "crlf.txt");
    const original = "alpha\r\nbeta\r\ngamma\r\n";
    await writeFile(path, original, "utf8");

    const lines = original.split(/\r?\n/);
    const anchors = anchorsFor(lines);
    const tool = registerToolForTest();

    await tool.execute(
      "call-1",
      {
        files: [
          {
            path: "crlf.txt",
            edits: [
              {
                edit_type: "replace",
                anchor: formatLineWithHash("beta", anchors[1]),
                end_anchor: formatLineWithHash("beta", anchors[1]),
                text: "BETA"
              }
            ]
          }
        ]
      },
      undefined,
      undefined,
      { cwd } as never
    );

    await expect(readFile(path, "utf8")).resolves.toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  it("does not request extra UI confirmation before applying edits", async () => {
    const cwd = await createTempDir();
    const path = join(cwd, "ui.txt");
    const original = "alpha\nbeta\n";
    await writeFile(path, original, "utf8");

    const anchors = anchorsFor(original.split(/\r?\n/));
    const tool = registerToolForTest();
    const confirm = vi.fn(() => {
      throw new Error("unexpected edit_file confirmation");
    });

    await tool.execute(
      "call-2",
      {
        files: [
          {
            path: "ui.txt",
            edits: [
              {
                edit_type: "replace",
                anchor: formatLineWithHash("beta", anchors[1]),
                end_anchor: formatLineWithHash("beta", anchors[1]),
                text: "BETA"
              }
            ]
          }
        ]
      },
      undefined,
      undefined,
      { cwd, hasUI: true, ui: { confirm } } as never
    );

    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(path, "utf8")).resolves.toBe("alpha\nBETA\n");
  });

  it("reports stale anchor failures with file path and line number", async () => {
    const cwd = await createTempDir();
    const path = join(cwd, "stale.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");

    const anchors = anchorsFor(["alpha", "beta", "gamma", ""]);
    const tool = registerToolForTest();

    await expect(
      tool.execute(
        "call-stale-anchor",
        {
          files: [
            {
              path: "stale.txt",
              edits: [
                {
                  edit_type: "replace",
                  anchor: formatLineWithHash("old beta", anchors[1]),
                  text: "BETA"
                }
              ]
            }
          ]
        },
        undefined,
        undefined,
        { cwd } as never
      )
    ).rejects.toThrow('Failed stale.txt edits[0]: anchor content mismatch at line 2; current "beta", requested "old beta"');
    await expect(
      tool.execute(
        "call-stale-anchor-details",
        {
          files: [
            {
              path: "stale.txt",
              edits: [
                {
                  edit_type: "replace",
                  anchor: formatLineWithHash("old beta", anchors[1]),
                  text: "BETA"
                }
              ]
            }
          ]
        },
        undefined,
        undefined,
        { cwd } as never
      )
    ).rejects.toMatchObject({
      message: 'Failed stale.txt edits[0]: anchor content mismatch at line 2; current "beta", requested "old beta"',
      details: {
        failures: [
          expect.objectContaining({
            anchor: anchors[1]
          })
        ]
      }
    });

    await expect(readFile(path, "utf8")).resolves.toBe("alpha\nbeta\ngamma\n");
  });

  it("does not write any files when one file in the batch fails validation", async () => {
    const cwd = await createTempDir();
    const invalidPath = join(cwd, "invalid.txt");
    const validPath = join(cwd, "valid.txt");
    await writeFile(invalidPath, "alpha\nbeta\n", "utf8");
    await writeFile(validPath, "one\ntwo\n", "utf8");

    const invalidAnchors = anchorsFor(["alpha", "beta", ""]);
    const validAnchors = anchorsFor(["one", "two", ""]);
    const tool = registerToolForTest();

    await expect(
      tool.execute(
        "call-atomic-failure",
        {
          files: [
            {
              path: "valid.txt",
              edits: [
                {
                  edit_type: "replace",
                  anchor: formatLineWithHash("two", validAnchors[1]),
                  text: "TWO"
                }
              ]
            },
            {
              path: "invalid.txt",
              edits: [
                {
                  edit_type: "replace_range",
                  anchor: formatLineWithHash("beta", invalidAnchors[1]),
                  text: "BETA"
                }
              ]
            }
          ]
        },
        undefined,
        undefined,
        { cwd } as never
      )
    ).rejects.toThrow(/Failed invalid\.txt: end_anchor is required for replace_range edits/);

    await expect(readFile(invalidPath, "utf8")).resolves.toBe("alpha\nbeta\n");
    await expect(readFile(validPath, "utf8")).resolves.toBe("one\ntwo\n");
  });

  it("marks batch failures as atomic (nothing applied)", async () => {
    const cwd = await createTempDir();
    const invalidPath = join(cwd, "invalid.txt");
    await writeFile(invalidPath, "alpha\nbeta\n", "utf8");

    const invalidAnchors = anchorsFor(["alpha", "beta", ""]);
    const tool = registerToolForTest();

    await expect(
      tool.execute(
        "call-atomic-batch",
        {
          files: [
            {
              path: "invalid.txt",
              edits: [
                {
                  edit_type: "replace_range",
                  anchor: formatLineWithHash("beta", invalidAnchors[1]),
                  text: "BETA"
                }
              ]
            }
          ]
        },
        undefined,
        undefined,
        { cwd } as never
      )
    ).rejects.toMatchObject({
      atomic: true
    });

    await expect(readFile(invalidPath, "utf8")).resolves.toBe("alpha\nbeta\n");
  });

  it("includes edit index in batch failure messages", async () => {
    const cwd = await createTempDir();
    const path = join(cwd, "stale.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");

    const anchors = anchorsFor(["alpha", "beta", "gamma", ""]);
    const tool = registerToolForTest();

    await expect(
      tool.execute(
        "call-multi-edit-failure",
        {
          files: [
            {
              path: "stale.txt",
              edits: [
                {
                  edit_type: "replace",
                  anchor: formatLineWithHash("old beta", anchors[1]),
                  text: "BETA"
                }
              ]
            }
          ]
        },
        undefined,
        undefined,
        { cwd } as never
      )
    ).rejects.toMatchObject({
      details: {
        failures: [
          expect.objectContaining({
            editIndex: 0
          })
        ]
      }
    });
  });

  it("rejects duplicate target paths without writing any files", async () => {
    const cwd = await createTempDir();
    const duplicatePath = join(cwd, "duplicate.txt");
    const otherPath = join(cwd, "other.txt");
    await writeFile(duplicatePath, "alpha\nbeta\n", "utf8");
    await writeFile(otherPath, "one\ntwo\n", "utf8");

    const duplicateAnchors = anchorsFor(["alpha", "beta", ""]);
    const otherAnchors = anchorsFor(["one", "two", ""]);
    const tool = registerToolForTest();

    await expect(
      tool.execute(
        "call-duplicate-target",
        {
          files: [
            {
              path: "other.txt",
              edits: [
                {
                  edit_type: "replace",
                  anchor: formatLineWithHash("two", otherAnchors[1]),
                  text: "TWO"
                }
              ]
            },
            {
              path: "duplicate.txt",
              edits: [
                {
                  edit_type: "replace",
                  anchor: formatLineWithHash("beta", duplicateAnchors[1]),
                  text: "BETA"
                }
              ]
            },
            {
              path: "./duplicate.txt",
              edits: [
                {
                  edit_type: "replace",
                  anchor: formatLineWithHash("alpha", duplicateAnchors[0]),
                  text: "ALPHA"
                }
              ]
            }
          ]
        },
        undefined,
        undefined,
        { cwd } as never
      )
    ).rejects.toThrow(`duplicate edit_file target path: ${duplicatePath}`);

    await expect(readFile(duplicatePath, "utf8")).resolves.toBe("alpha\nbeta\n");
    await expect(readFile(otherPath, "utf8")).resolves.toBe("one\ntwo\n");
  });

  it("rejects duplicate symlink target paths quickly without writing files", async () => {
    const cwd = await createTempDir();
    const targetPath = join(cwd, "target.txt");
    const aliasPath = join(cwd, "target-alias.txt");
    const original = "alpha\nbeta\n";
    await writeFile(targetPath, original, "utf8");
    await symlink(targetPath, aliasPath, "file");

    const targetAnchors = anchorsFor(["alpha", "beta", ""]);
    const tool = registerToolForTest();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("timed out waiting for duplicate symlink target rejection")), 500);
    });

    try {
      await expect(
        Promise.race([
          tool.execute(
            "call-duplicate-symlink-target",
            {
              files: [
                {
                  path: "target.txt",
                  edits: [
                    {
                      edit_type: "replace",
                      anchor: formatLineWithHash("beta", targetAnchors[1]),
                      text: "BETA"
                    }
                  ]
                },
                {
                  path: "target-alias.txt",
                  edits: [
                    {
                      edit_type: "replace",
                      anchor: formatLineWithHash("alpha", targetAnchors[0]),
                      text: "ALPHA"
                    }
                  ]
                }
              ]
            },
            undefined,
            undefined,
            { cwd } as never
          ),
          timeoutPromise
        ])
      ).rejects.toThrow(`duplicate edit_file target path: ${aliasPath}`);
    } finally {
      clearTimeout(timeout);
    }

    await expect(readFile(targetPath, "utf8")).resolves.toBe(original);
  });

  it("returns unified diff details for anchored edits", async () => {
    const cwd = await createTempDir();
    const filePath = join(cwd, "sample.ts");
    await writeFile(filePath, "const value = 1;\nconsole.log(value);\n", "utf8");

    const anchors = anchorsFor(["const value = 1;", "console.log(value);", ""]);
    const tool = registerToolForTest();
    const result = await tool.execute(
      "call-diff",
      {
        files: [
          {
            path: "sample.ts",
            edits: [
              {
                edit_type: "replace",
                anchor: formatLineWithHash("const value = 1;", anchors[0]),
                end_anchor: formatLineWithHash("const value = 1;", anchors[0]),
                text: "const value = 2;"
              }
            ]
          }
        ]
      },
      undefined,
      undefined,
      { cwd } as never
    );

    expect(result.details).toMatchObject({ files: ["sample.ts"] });
    expect(result.details?.diff).toContain("-1 const value = 1;");
    expect(result.details?.diff).toContain("+1 const value = 2;");
    expect(result.details?.diffs).toEqual([
      expect.objectContaining({ path: "sample.ts", firstChangedLine: 1 })
    ]);
  });

  it("surfaces the end_anchor hint for multi-line failures through execute", async () => {
    const cwd = await createTempDir();
    const path = join(cwd, "stale.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");

    const anchors = anchorsFor(["alpha", "beta", "gamma", ""]);
    const tool = registerToolForTest();

    await expect(
      tool.execute(
        "call-multiline-stale",
        {
          files: [
            {
              path: "stale.txt",
              edits: [
                {
                  edit_type: "replace",
                  anchor:
                    [
                      formatLineWithHash("alpha", anchors[0]),
                      `${anchors[1]}\u2502stale beta`
                    ].join("\n"),
                  text: "ALPHA"
                }
              ]
            }
          ]
        },
        undefined,
        undefined,
        { cwd } as never
      )
    ).rejects.toThrow(
      /Failed stale\.txt edits\[0\]: multi-line anchors are not supported directly; use a single-line anchor with end_anchor/
    );
  });
});
