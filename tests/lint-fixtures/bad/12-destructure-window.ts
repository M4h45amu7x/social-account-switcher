const { chrome: c } = window;
export async function probe(): Promise<void> {
  c.cookies.getAll({});
}
