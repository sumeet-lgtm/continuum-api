// Spintax: {A|B|C} → random choice. Requires | so {{var}} double-braces are not consumed.
export function resolveSpintax(text: string): string {
  return text.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, group: string) => {
    const options = group.split('|');
    return options[Math.floor(Math.random() * options.length)] ?? '';
  });
}

// Liquid-style conditionals: {% if VAR %}...{% else %}...{% endif %}
export function resolveLiquid(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\{%\s*if\s+(\w+)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g,
    (_, varName: string, truePart: string, falsePart?: string) => {
      const val = vars[varName];
      return val && val.trim() ? truePart : (falsePart ?? '');
    },
  );
}

// Variable substitution: {{var_name}} → value
export function resolveVariables(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

// Run all three in order: spintax → liquid → variables
export function processTemplate(template: string, vars: Record<string, string>): string {
  return resolveVariables(resolveLiquid(resolveSpintax(template), vars), vars);
}
