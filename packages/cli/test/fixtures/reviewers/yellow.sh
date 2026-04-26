#!/usr/bin/env bash
cat /dev/stdin > /dev/null
echo "REPOKERNEL_RESULT_START"
echo '{"schema_version":1,"reviewer_id":"yellow","verdict":"YELLOW","findings":[{"severity":"P2","message":"Minor style issue found"}]}'
echo "REPOKERNEL_RESULT_END"
