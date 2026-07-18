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
REPO="lodebar2026/jpeditor"
PAGES_URL="https://lodebar2026.github.io/jpeditor/"
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

# —— 发布后校验 GitHub Pages：抓线上 index.html，逐个验证它引用的本站资源都返回 200 ——
# 改名/改 base 后最容易出的坑：页面还引用旧前缀的 /assets/*，全部 404、页面白屏但 run 仍绿。
echo "==> 校验 Pages 部署（${PAGES_URL}）…"
HOST="$(printf '%s' "${PAGES_URL}" | sed -E 's#(https?://[^/]+).*#\1#')"      # https://lodebar2026.github.io
BASEPATH="$(printf '%s' "${PAGES_URL}" | sed -E 's#https?://[^/]+##')"        # /jpeditor/
check_pages() {
  local html paths p code bad=0
  # 部署完成后 CDN 传播可能有几秒延迟，带缓存穿透参数重试
  for _ in $(seq 1 12); do
    html="$(curl -fsSL "${PAGES_URL}?_=$(date +%s)" 2>/dev/null || true)"
    [ -n "${html}" ] && break
    sleep 5
  done
  [ -z "${html}" ] && { echo "!! 拉取 ${PAGES_URL} 失败"; return 1; }
  paths="$(printf '%s' "${html}" | grep -oE "(src|href)=\"${BASEPATH}[^\"]+\"" \
    | sed -E 's/.*"([^"]+)"/\1/' | sort -u)"
  [ -z "${paths}" ] && { echo "!! 页面未引用任何 ${BASEPATH} 资源（base 前缀可能不对）"; return 1; }
  while IFS= read -r p; do
    [ -z "${p}" ] && continue
    code="$(curl -s -o /dev/null -w '%{http_code}' "${HOST}${p}")"
    if [ "${code}" = "200" ]; then echo "   ok  ${code}  ${p}"; else echo "   BAD ${code}  ${p}"; bad=1; fi
  done <<< "${paths}"
  return ${bad}
}
if ! check_pages; then
  echo "!! Pages 资源校验未通过，保留 run ${RUN_ID} 以便排查：https://github.com/${REPO}/actions/runs/${RUN_ID}"
  exit 1
fi
echo "==> Pages 资源校验通过"

echo "==> 删除 run ${RUN_ID}"
gh run delete "${RUN_ID}" --repo "${REPO}"
echo "==> 完成：${TAG} 已发布，run ${RUN_ID} 已删除"
