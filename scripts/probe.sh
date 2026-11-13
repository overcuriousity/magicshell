#!/bin/sh
# Posts the expected_json of every fixtures/systemone/request-*.json to <endpoint>/systemone
# and prints "# <name> <status>" followed by the body. The key is read from the environment and
# handed to curl on stdin, so it appears in no argument list and no output.
# Needs jq, curl, MAGICSHELL_ENDPOINT and MAGICSHELL_MODEL; MAGICSHELL_KEY is optional and the
# Authorization header is left out when it is empty.
set -eu

: "${MAGICSHELL_ENDPOINT:?set MAGICSHELL_ENDPOINT}"
: "${MAGICSHELL_MODEL:?set MAGICSHELL_MODEL}"
dir=${FIXTURES:-fixtures/systemone}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for f in "$dir"/request-*.json; do
  name=$(basename "$f" .json)
  jq -r '.expected_json' "$f" | jq -c --arg model "$MAGICSHELL_MODEL" '.model = $model' > "$tmp/body"
  if [ -n "${MAGICSHELL_KEY:-}" ]; then
    status=$(printf 'Authorization: Bearer %s\n' "$MAGICSHELL_KEY" |
      curl -sS -o "$tmp/out" -w '%{http_code}' -X POST "$MAGICSHELL_ENDPOINT/systemone" \
        -H 'Content-Type: application/json' -H @- --data-binary "@$tmp/body")
  else
    status=$(curl -sS -o "$tmp/out" -w '%{http_code}' -X POST "$MAGICSHELL_ENDPOINT/systemone" \
      -H 'Content-Type: application/json' --data-binary "@$tmp/body")
  fi
  printf '# %s %s\n' "$name" "$status"
  cat "$tmp/out"
  printf '\n'
done
