export async function probe(): Promise<void> {
  parent.chrome.cookies.getAll({});
  top?.chrome.cookies.getAll({});
}
