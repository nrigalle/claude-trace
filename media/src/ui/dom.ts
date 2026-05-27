export const setIfChanged = (el: HTMLElement, value: string): void => {
  if (el.textContent !== value) el.textContent = value;
};
