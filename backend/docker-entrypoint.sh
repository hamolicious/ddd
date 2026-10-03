#!/bin/sh
set -eu

base="${BASE_PLUGINS_DIR:-/srv/plugins}"
dir="${PLUGINS_DIR:-/srv/data/plugins}"
owned="$dir.base"

mkdir -p "$dir" "${PLUGIN_STAGING_DIR:-$dir.staging}"

if [ -d "$base" ] && [ "$(cd "$base" && pwd -P)" != "$(cd "$dir" && pwd -P)" ]; then
  if [ -f "$owned" ]; then
    while IFS= read -r entry; do
      if [ -n "$entry" ] && [ ! -d "$base/$entry" ]; then
        rm -rf "${dir:?}/$entry"
        rmdir "$dir/${entry%/*}" 2>/dev/null || true
      fi
    done < "$owned"
  fi

  : > "$owned.next"
  for path in "$base"/*/*/; do
    [ -d "$path" ] || continue
    entry="${path#"$base"/}"
    entry="${entry%/}"
    rm -rf "${dir:?}/$entry"
    mkdir -p "$dir/${entry%/*}"
    cp -R "$base/$entry" "$dir/$entry"
    printf '%s\n' "$entry" >> "$owned.next"
  done
  mv "$owned.next" "$owned"
fi

exec /usr/local/bin/ddd "$@"
