#!/bin/sh
# Copy the shared report-reading code from the web app into the inbound-email server function.
cd "$(dirname "$0")/.."
cp web/src/lib/core.ts supabase/functions/inbound-email/core.ts
sed 's#from "./core";#from "./core.ts";#' web/src/lib/extract.ts > supabase/functions/inbound-email/extract.ts
