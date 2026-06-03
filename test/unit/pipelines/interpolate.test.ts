import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  interpolate,
  evaluateCondition,
  referencedVars,
  isValidVarName,
  type InterpolationContext,
} from "../../../src/features/pipelines/domain/interpolate";

const ctx = (over: Partial<InterpolationContext> = {}): InterpolationContext => ({
  workspace: "/runs/abc",
  vars: { name: "alex", ticket: "API-42" },
  blockOutputs: { "design-1": "the design doc", "build-2": "" },
  ...over,
});

describe("interpolate", () => {
  it("resolves ${workspace} to the run workspace path", () => {
    expect(interpolate("cd ${workspace} && ls", ctx())).toBe("cd /runs/abc && ls");
  });

  it("resolves ${vars.NAME} from the variable map", () => {
    expect(interpolate("Hi ${vars.name}, ticket ${vars.ticket}", ctx())).toBe(
      "Hi alex, ticket API-42",
    );
  });

  it("resolves ${blocks.ID.output} from prior block outputs", () => {
    expect(interpolate("Use: ${blocks.design-1.output}", ctx())).toBe("Use: the design doc");
  });

  it("resolves a recognized-but-undefined var/block reference to empty so the literal token never leaks into prompts/URLs/code", () => {
    expect(interpolate("a${vars.missing}b${blocks.nope.output}c", ctx())).toBe("abc");
  });

  it("leaves a truly unrecognized ${...} token untouched", () => {
    expect(interpolate("keep ${bogus} and ${vars.name}", ctx())).toBe("keep ${bogus} and alex");
  });

  it("resolves a block output that is the empty string (present but empty) rather than leaving the token", () => {
    expect(interpolate("[${blocks.build-2.output}]", ctx())).toBe("[]");
  });

  it("resolves multiple references in one template", () => {
    expect(
      interpolate("${vars.name} @ ${workspace} -> ${blocks.design-1.output}", ctx()),
    ).toBe("alex @ /runs/abc -> the design doc");
  });

  it("tolerates surrounding whitespace inside the braces", () => {
    expect(interpolate("${ vars.name }", ctx())).toBe("alex");
  });

  it("does not recursively re-interpolate a resolved value containing a token", () => {
    const c = ctx({ vars: { a: "${vars.b}", b: "SHOULD_NOT_APPEAR" } });
    expect(interpolate("${vars.a}", c)).toBe("${vars.b}");
  });

  it("property: a template with no ${ } is returned unchanged", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }).filter((s) => !s.includes("${")),
        (s) => {
          expect(interpolate(s, ctx())).toBe(s);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("property: every defined var resolves to exactly its value", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/),
          fc.string({ maxLength: 50 }).filter((v) => !v.includes("${")),
          { maxKeys: 10 },
        ),
        (vars) => {
          const c = ctx({ vars });
          for (const [k, v] of Object.entries(vars)) {
            expect(interpolate(`<${"$"}{vars.${k}}>`, c)).toBe(`<${v}>`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("referencedVars", () => {
  it("extracts the set of referenced variable names", () => {
    expect([...referencedVars("${vars.a} ${vars.b} ${vars.a} ${workspace}")].sort()).toEqual(["a", "b"]);
  });

  it("returns empty when no vars are referenced", () => {
    expect(referencedVars("plain ${workspace} ${blocks.x.output}")).toEqual([]);
  });
});

describe("isValidVarName", () => {
  it("accepts identifiers", () => {
    expect(isValidVarName("foo")).toBe(true);
    expect(isValidVarName("_x9")).toBe(true);
  });
  it("rejects non-identifiers", () => {
    expect(isValidVarName("1abc")).toBe(false);
    expect(isValidVarName("a-b")).toBe(false);
    expect(isValidVarName("a b")).toBe(false);
    expect(isValidVarName("")).toBe(false);
  });
});

describe("evaluateCondition", () => {
  const c = ctx({ vars: { status: "done", count: "5", text: "all good LGTM", flag: "true", off: "false", empty: "" } });

  it("== compares equality after interpolation", () => {
    expect(evaluateCondition("${vars.status} == done", c)).toBe(true);
    expect(evaluateCondition("${vars.status} == pending", c)).toBe(false);
  });
  it("!= compares inequality", () => {
    expect(evaluateCondition("${vars.status} != pending", c)).toBe(true);
    expect(evaluateCondition("${vars.status} != done", c)).toBe(false);
  });
  it("strips quotes around operands", () => {
    expect(evaluateCondition('${vars.status} == "done"', c)).toBe(true);
  });
  it("contains / !contains test substrings", () => {
    expect(evaluateCondition("${vars.text} contains LGTM", c)).toBe(true);
    expect(evaluateCondition("${vars.text} !contains REJECT", c)).toBe(true);
    expect(evaluateCondition("${vars.text} contains REJECT", c)).toBe(false);
  });
  it("numeric comparisons", () => {
    expect(evaluateCondition("${vars.count} > 3", c)).toBe(true);
    expect(evaluateCondition("${vars.count} < 3", c)).toBe(false);
    expect(evaluateCondition("${vars.count} >= 5", c)).toBe(true);
    expect(evaluateCondition("${vars.count} <= 4", c)).toBe(false);
  });
  it("bare value is truthy unless falsy-like, empty, or an undefined variable", () => {
    expect(evaluateCondition("${vars.flag}", c)).toBe(true);
    expect(evaluateCondition("${vars.off}", c)).toBe(false);
    expect(evaluateCondition("${vars.empty}", c)).toBe(false);
    expect(evaluateCondition("${vars.missing}", c)).toBe(false);
  });
  it("never throws on malformed conditions — a bad branch expression cannot abort a running pipeline", () => {
    expect(() => evaluateCondition("garbage with no operator", c)).not.toThrow();
    expect(typeof evaluateCondition("garbage with no operator", c)).toBe("boolean");
    expect(() => evaluateCondition("${vars.count} ~= 5", c)).not.toThrow();
    expect(typeof evaluateCondition("${vars.count} ~= 5", c)).toBe("boolean");
    expect(evaluateCondition("${vars.status} > 3", c)).toBe(false);
    expect(evaluateCondition("${vars.count} > notanumber", c)).toBe(false);
  });
});
