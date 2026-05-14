type Attrs<K extends keyof HTMLElementTagNameMap> = Partial<{
  className: string;
  innerHTML: string;
  textContent: string;
  style: Partial<CSSStyleDeclaration>;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  on: Partial<{
    [E in keyof HTMLElementEventMap]: (
      this: HTMLElementTagNameMap[K],
      ev: HTMLElementEventMap[E],
    ) => void;
  }>;
}>;

type Child = Node | string | null | undefined | false;

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs<K>,
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);

  if (attrs) {
    if (attrs.className) el.className = attrs.className;
    if (attrs.innerHTML !== undefined) el.innerHTML = attrs.innerHTML;
    if (attrs.textContent !== undefined) el.textContent = attrs.textContent;
    if (attrs.style) Object.assign(el.style, attrs.style);
    if (attrs.dataset) {
      for (const [k, v] of Object.entries(attrs.dataset)) el.dataset[k] = v;
    }
    if (attrs.attrs) {
      for (const [k, v] of Object.entries(attrs.attrs)) el.setAttribute(k, v);
    }
    if (attrs.on) {
      for (const [event, handler] of Object.entries(attrs.on)) {
        if (handler) {
          el.addEventListener(event, handler as EventListener);
        }
      }
    }
  }

  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === "string") el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  }

  return el;
};

export const clear = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};
