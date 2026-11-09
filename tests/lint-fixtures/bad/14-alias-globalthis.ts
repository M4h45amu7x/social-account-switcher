const g = globalThis;
export async function probe(): Promise<void> {
  g.chrome.cookies.getAll({});
}
