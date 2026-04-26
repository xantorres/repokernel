#!/usr/bin/env bash
cat /dev/stdin > /dev/null
echo "REPOKERNEL_RESULT_START"
echo '{"schema_version":1,"reviewer_id":"red","verdict":"RED","findings":[{"severity":"P0","message":"Critical security issue detected"}]}'
echo "REPOKERNEL_RESULT_END"
