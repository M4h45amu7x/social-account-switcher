export async function probe(): Promise<void> {
  frames['chrome'].cookies.getAll({});
}
