# Keep the CLI link during upgrades. Remove only the link owned by this package.
case "$1" in
  upgrade|failed-upgrade|[1-9]*) ;;
  *)
    taskboard_cli='/opt/${sanitizedProductName}/resources/bin/ai-taskboard'
    taskboard_link='/usr/bin/ai-taskboard'
    if [ -L "$taskboard_link" ] && [ "$(readlink "$taskboard_link")" = "$taskboard_cli" ]; then
      rm "$taskboard_link"
    fi
    ;;
esac
