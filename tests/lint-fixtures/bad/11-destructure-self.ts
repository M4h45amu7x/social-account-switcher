const { chrome } = self;
export async function probe(): Promise<void> {
  chrome.cookies.getAll({});
}
