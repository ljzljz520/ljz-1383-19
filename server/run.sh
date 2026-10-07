#!/usr/bin/env bash
# 无 root 环境下为 Chromium 提供本地解包的系统库（见 .local-libs）
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$DIR/.local-libs" ]; then
  LIBDIRS=$(find "$DIR/.local-libs" -type f -name '*.so*' -printf '%h\n' 2>/dev/null | sort -u | tr '\n' ':')
  export LD_LIBRARY_PATH="${LIBDIRS}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
export NODE_PATH="$DIR/node_modules"
exec node "$DIR/src/main.js"
