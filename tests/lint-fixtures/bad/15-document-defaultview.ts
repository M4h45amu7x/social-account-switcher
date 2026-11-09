export async function probe(): Promise<void> {
  document.defaultView?.chrome.cookies.getAll({});
}
