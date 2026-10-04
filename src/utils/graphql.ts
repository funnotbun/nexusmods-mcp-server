/** A small executable-document parser. All operation definitions must be queries;
 *  exactly one operation is accepted (the API call has no operationName). Schema
 *  validation remains the API's job. Comments and string values are lexical tokens. */
export function assertQuery(document: string): void {
  if (document.length > 100_000) throw new Error("GraphQL document too large");
  const tokens: string[] = [];
  const lex = /\s+|,|\uFEFF|#[^\r\n]*|"""(?:\\"""|[\s\S])*?"""|"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\x00-\x1f])*"|\.\.\.|[_A-Za-z][_0-9A-Za-z]*|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[!$():=@\[\]{}|&]/y;
  let pos = 0;
  while (pos < document.length) {
    lex.lastIndex = pos;
    const match = lex.exec(document);
    if (!match) throw new Error("Invalid GraphQL syntax");
    pos = lex.lastIndex;
    if (!/^(?:\s|,|\uFEFF|#)/.test(match[0])) tokens.push(match[0]);
  }
  let i = 0, depth = 0, operations = 0;
  const peek = () => tokens[i];
  const take = (token: string) => { if (peek() !== token) throw new Error("Invalid GraphQL syntax"); i++; };
  const name = () => { if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(peek() || "")) throw new Error("Expected GraphQL name"); return tokens[i++]; };
  const nest = (fn: () => void) => { if (++depth > 100) throw new Error("GraphQL nesting too deep"); try { fn(); } finally { depth--; } };
  const value = (constant = false): void => nest(() => {
    if (peek() === "$" && !constant) { i++; name(); }
    else if (peek() === "[") { i++; while (peek() && peek() !== "]") value(constant); take("]"); }
    else if (peek() === "{") { i++; while (peek() && peek() !== "}") { name(); take(":"); value(constant); } take("}"); }
    else if (/^(?:"|-?\d)/.test(peek() || "")) i++;
    else name();
  });
  const arguments_ = (): void => {
    if (peek() !== "(") return;
    i++; name(); take(":"); value();
    while (peek() && peek() !== ")") { name(); take(":"); value(); }
    take(")");
  };
  const directives = () => { while (peek() === "@") { i++; name(); arguments_(); } };
  const type = (): void => nest(() => { if (peek() === "[") { i++; type(); take("]"); } else name(); if (peek() === "!") i++; });
  const selection = (): void => nest(() => {
    take("{");
    if (peek() === "}") throw new Error("Empty GraphQL selection");
    while (peek() && peek() !== "}") {
      if (peek() === "...") {
        i++;
        if (peek() === "on") { i++; name(); directives(); selection(); }
        else if (peek() === "@" || peek() === "{") { directives(); selection(); }
        else { name(); directives(); }
      } else {
        name(); if (peek() === ":") { i++; name(); }
        arguments_(); directives(); if (peek() === "{") selection();
      }
    }
    take("}");
  });
  while (i < tokens.length) {
    if (peek() === "fragment") {
      i++; if (name() === "on") throw new Error("Invalid fragment name");
      take("on"); name(); directives(); selection();
    } else {
      operations++;
      if (peek() !== "{") {
        if (name() !== "query") throw new Error("Only read queries are allowed");
        if (/^[_A-Za-z]/.test(peek() || "")) name();
        if (peek() === "(") {
          i++;
          do { take("$"); name(); take(":"); type(); if (peek() === "=") { i++; value(true); } directives(); } while (peek() && peek() !== ")");
          take(")");
        }
        directives();
      }
      selection();
    }
  }
  if (operations !== 1) throw new Error("Exactly one query operation is required");
}
