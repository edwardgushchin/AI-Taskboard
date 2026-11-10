#!/bin/sh
set -eu

tool='/Applications/AI Taskboard.app/Contents/Resources/bin/ai-taskboard'
link='/usr/local/bin/ai-taskboard'
if [ -x "$tool" ] && [ ! -e "$link" ] && [ ! -L "$link" ]; then
  mkdir -p /usr/local/bin
  ln -s "$tool" "$link"
fi
