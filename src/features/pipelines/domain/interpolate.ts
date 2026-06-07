import { assertNever } from "../../../shared/assertNever";

export interface InterpolationContext {
  readonly workspace: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly blockOutputs: Readonly<Record<string, string>>;
}

const resolveExpr = (expr: string, ctx: InterpolationContext, bareVars: boolean): string | null => {
  if (expr === "workspace") return ctx.workspace;
  const varMatch = /^vars\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr);
  if (varMatch) return ctx.vars[varMatch[1]!] ?? "";
  const blockMatch = /^blocks\.(.+)\.output$/.exec(expr);
  if (blockMatch) return ctx.blockOutputs[blockMatch[1]!] ?? "";
  if (bareVars && /^[A-Za-z_][A-Za-z0-9_]*$/.test(expr) && expr in ctx.vars) return ctx.vars[expr] ?? "";
  return null;
};

export const interpolate = (
  template: string,
  ctx: InterpolationContext,
  opts: { readonly bareVars?: boolean } = {},
): string =>
  template.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
    const resolved = resolveExpr(expr.trim(), ctx, opts.bareVars === true);
    return resolved ?? whole;
  });

export const referencedVars = (template: string): readonly string[] => {
  const names = new Set<string>();
  for (const m of template.matchAll(/\$\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}/g)) {
    names.add(m[1]!);
  }
  return [...names];
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const isValidVarName = (name: string): boolean => IDENTIFIER.test(name);

const unquote = (s: string): string => {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
};

const FALSY = new Set(["", "false", "0", "null", "undefined", "no"]);

export type ConditionOperator = "==" | "!=" | "contains" | "!contains" | ">" | "<" | ">=" | "<=";

const OPERATORS: readonly ConditionOperator[] = ["!contains", "contains", ">=", "<=", "!=", "==", ">", "<"];

export const evaluateCondition = (expression: string, ctx: InterpolationContext): boolean => {
  const resolved = interpolate(expression, ctx);
  for (const op of OPERATORS) {
    const token = ` ${op} `;
    const idx = resolved.indexOf(token);
    if (idx === -1) continue;
    const left = unquote(resolved.slice(0, idx));
    const right = unquote(resolved.slice(idx + token.length));
    switch (op) {
      case "==": return left === right;
      case "!=": return left !== right;
      case "contains": return left.includes(right);
      case "!contains": return !left.includes(right);
      case ">": return numeric(left) > numeric(right);
      case "<": return numeric(left) < numeric(right);
      case ">=": return numeric(left) >= numeric(right);
      case "<=": return numeric(left) <= numeric(right);
      default: return assertNever(op);
    }
  }
  return !FALSY.has(resolved.trim().toLowerCase());
};

const numeric = (s: string): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};
