set -euo pipefail
cd "$(dirname "$(realpath "$0")")"

bash ./touchstone.sh status
