export async function probe(): Promise<void> {
  globalThis['chrome'].cookies.getAll({});
}
