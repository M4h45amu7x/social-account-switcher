export async function probe(): Promise<void> {
  window.chrome.cookies.getAll({});
}
