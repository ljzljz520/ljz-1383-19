#!/bin/bash
export LD_LIBRARY_PATH="/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu:/tmp/chromedeps/root/lib/aarch64-linux-gnu:$LD_LIBRARY_PATH"
exec /home/node/.cache/puppeteer/chrome/linux-157.0.8089.0/chrome-linux64/chrome "$@"
