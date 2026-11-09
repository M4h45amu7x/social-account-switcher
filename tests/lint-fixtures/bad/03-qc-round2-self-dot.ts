export async function probe(): Promise<void> {
  self.chrome.cookies.getAll({});
}
