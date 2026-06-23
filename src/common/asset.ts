// Resolve a public-dir asset path against Vite's configured base.
// Tauri/桌面构建 base 为 "/"，GitHub Pages 子路径部署时 base 为 "/jpeditor-web/"。
// 传入相对路径（如 "redist/Bravura.woff2"，前导 "/" 会被剥掉）即可两端自洽。
export function asset(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}
