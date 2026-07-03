#!/usr/bin/env bash
# 本地发布脚本：bump 版本 → 提交推送 → 建 release（触发 Build）→ 等 run 跑完 → 自动 gh run delete。
# 「发布完成后自动删 run」在本地做，不用 CI 工作流（run 无法自删，且约定不改 .github/workflows/*.yml）。
#
# 用法：  scripts/release.sh <version> [发布说明...]
#   scripts/release.sh 0.4.2
#   scripts/release.sh 0.4.2 "修复 X" "新增 Y"
set -euo pipefail

VER="${1:?用法: scripts/release.sh <version> [notes...]}"
shift || true
TAG="v${VER}"
REPO="lodebar2026/jpeditor-web"
cd "$(dirname "$0")/.."

# 约定：本项目提交/推送用 lodebar2026 帐号
gh auth switch --user lodebar2026 >/dev/null 2>&1 || true

echo "==> bump 版本 → ${VER}"
sed -i '' "s/\"version\": \"[0-9][0-9.]*\"/\"version\": \"${VER}\"/" package.json src-tauri/tauri.conf.json
sed -i '' "s/^version = \"[0-9][0-9.]*\"/version = \"${VER}\"/" src-tauri/Cargo.toml
( cd src-tauri && cargo update -p jpeditor --precise "${VER}" >/dev/null 2>&1 || true )

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "发布 ${TAG}"
git push origin main

echo "==> 建 release ${TAG}（触发 Build）"
NOTES=""
for n in "$@"; do NOTES+="- ${n}"$'\n'; done
gh release create "${TAG}" --repo "${REPO}" --target main --title "${TAG}" \
  --notes "${NOTES:-Release ${TAG}}"

echo "==> 等待 Build run 完成…"
# release 触发的 run 略有延迟，轮询取回本 tag 的 run id
RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID="$(gh run list --repo "${REPO}" --workflow Build --branch "${TAG}" \
    --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
  [ -n "${RUN_ID}" ] && break
  sleep 5
done
if [ -z "${RUN_ID}" ]; then
  echo "!! 没抓到 Build run，请稍后手动 gh run delete"; exit 0
fi
gh run watch "${RUN_ID}" --repo "${REPO}" --exit-status || true

echo "==> 删除 run ${RUN_ID}"
gh run delete "${RUN_ID}" --repo "${REPO}"
echo "==> 完成：${TAG} 已发布，run ${RUN_ID} 已删除"
