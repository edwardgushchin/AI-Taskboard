# Register the standalone CLI alongside the desktop launcher.
taskboard_cli='/opt/${sanitizedProductName}/resources/bin/ai-taskboard'
taskboard_link='/usr/bin/ai-taskboard'
if [ -x "$taskboard_cli" ] && [ ! -e "$taskboard_link" ] && [ ! -L "$taskboard_link" ]; then
  ln -s "$taskboard_cli" "$taskboard_link"
fi
