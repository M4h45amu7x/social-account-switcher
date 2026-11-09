export async function probe(): Promise<void> {
  chrome.cookies.getAll({});
}
