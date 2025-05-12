#!/bin/bash

set -e

FUEL_LIMIT=${FUEL_LIMIT:-1000000000000}
MAX_GAS=${MAX_GAS:-5000000}
FILE_LOCATION=${FILE_LOCATION:-".docker/service.json"}
TRIGGER_CHAIN=${TRIGGER_CHAIN:-"local"}
SUBMIT_CHAIN=${SUBMIT_CHAIN:-"local"}
AGGREGATOR_URL=${AGGREGATOR_URL:-"http://127.0.0.1:8001"}
# used in make upload-component
WAVS_ENDPOINT=${WAVS_ENDPOINT:-"http://localhost:8000"}
export DOCKER_DEFAULT_PLATFORM=linux/amd64

SERVICE_MANAGER_ADDR=`jq -r .addresses.WavsServiceManager .nodes/avs_deploy.json`

# === Addresses ===
REWARD_DISTRIBUTOR_ADDR=`jq -r '.reward_distributor' "./.docker/script_deploy.json"`
REWARD_TOKEN_ADDR=`jq -r '.reward_token' "./.docker/script_deploy.json"`
MINTER_ADDR=`jq -r '.minter' "./.docker/script_deploy.json"`
NFT_ADDR=`jq -r '.nft' "./.docker/script_deploy.json"`

# === Rewards ===
REWARDS_COMPONENT_FILENAME=rewards.wasm
# REWARDS_TRIGGER_EVENT="WavsRewardsTrigger(uint64)"
REWARDS_CRON_SCHEDULE="0 0 * * * *"
REWARDS_ENV_VARS="WAVS_ENV_PINATA_API_URL,WAVS_ENV_PINATA_API_KEY"
REWARDS_CONFIG="reward_token=${REWARD_TOKEN_ADDR},nft=${NFT_ADDR}"

# === Autonomous Artist ===
AUTONOMOUS_ARTIST_COMPONENT_FILENAME=autonomous_artist.wasm
AUTONOMOUS_ARTIST_TRIGGER_EVENT="WavsNftTrigger(address,string,uint64,uint8,uint256)"
AUTONOMOUS_ARTIST_ENV_VARS="${REWARDS_ENV_VARS},WAVS_ENV_OLLAMA_API_URL,WAVS_ENV_SD_API_URL"
AUTONOMOUS_ARTIST_CONFIG="nft_contract=${NFT_ADDR}"

## === Simple Relay ===
AUTONOMOUS_ARTIST_SIMPLE_RELAY_COMPONENT_FILENAME=autonomous_artist_simple_relay.wasm
AUTONOMOUS_ARTIST_SIMPLE_RELAY_TRIGGER_EVENT="WavsNftMint(address,uint256,string,uint64)"


# === Core ===

BASE_CMD="docker run --rm --network host -w /data -v $(pwd):/data ghcr.io/lay3rlabs/wavs:0.4.0-beta.1 wavs-cli service --json true --home /data --file /data/${FILE_LOCATION}"

SERVICE_ID=`$BASE_CMD init --name demo | jq -r .id`
echo "Service ID: ${SERVICE_ID}"

# If no aggregator is set, use the default (during workflow submit)
WORKFLOW_SUB_CMD="set-evm"
if [ -n "$AGGREGATOR_URL" ]; then
    WORKFLOW_SUB_CMD="set-aggregator --url ${AGGREGATOR_URL}"
fi

function new_workflow() {
    local trigger_address=$1
    local submit_address=$2
    local event_type=$3 # "event" or "cron"
    local trigger_event_or_cron_schedule=$4
    local component_filename=$5
    local env_vars=$6
    local config=$7

    local workflow_id=`$BASE_CMD workflow add | jq -r '.workflows | to_entries | map(select(.value.component == "unset")) | .[0].key'`
    echo "Workflow ID: ${workflow_id}"

    if [ "${event_type}" == "event" ]; then
        local trigger_event_hash=`cast keccak ${trigger_event_or_cron_schedule}`
        $BASE_CMD workflow trigger --id ${workflow_id} set-evm --address ${trigger_address} --chain-name ${TRIGGER_CHAIN} --event-hash ${trigger_event_hash} > /dev/null
    elif [ "${event_type}" == "cron" ]; then
        # no CMD for cron yet, edit the service.json file directly
        tmp=$(mktemp)
        jq '.workflows["'${workflow_id}'"].trigger = { "cron": { "schedule": "'"$trigger_event_or_cron_schedule"'", "start_time": null, "end_time": null } }' ${FILE_LOCATION} > ${tmp}
        mv ${tmp} ${FILE_LOCATION}
    fi

    $BASE_CMD workflow submit --id ${workflow_id} ${WORKFLOW_SUB_CMD} --address ${submit_address} --chain-name ${SUBMIT_CHAIN} --max-gas ${MAX_GAS} > /dev/null

    local digest=`COMPONENT_FILENAME=${component_filename} make --no-print-directory upload-component | cut -d':' -f2`
    $BASE_CMD workflow component --id ${workflow_id} set-source-digest --digest ${digest} > /dev/null
    $BASE_CMD workflow component --id ${workflow_id} permissions --http-hosts '*' --file-system true > /dev/null
    $BASE_CMD workflow component --id ${workflow_id} time-limit --seconds 1800 > /dev/null
    if [ -n "${env_vars}" ]; then
        $BASE_CMD workflow component --id ${workflow_id} env --values ${env_vars} > /dev/null
    fi
    if [ -n "${config}" ]; then
        $BASE_CMD workflow component --id ${workflow_id} config --values ${config} > /dev/null
    fi
}

# === Rewards ===
new_workflow ${REWARD_DISTRIBUTOR_ADDR} ${REWARD_DISTRIBUTOR_ADDR} "cron" "${REWARDS_CRON_SCHEDULE}" ${REWARDS_COMPONENT_FILENAME} ${REWARDS_ENV_VARS} ${REWARDS_CONFIG}

# === Autonomous Artist (minter -> nft AND nft -> nft) ===
new_workflow ${MINTER_ADDR} ${NFT_ADDR} "event" ${AUTONOMOUS_ARTIST_TRIGGER_EVENT} ${AUTONOMOUS_ARTIST_COMPONENT_FILENAME} ${AUTONOMOUS_ARTIST_ENV_VARS} ${AUTONOMOUS_ARTIST_CONFIG}
new_workflow ${NFT_ADDR} ${NFT_ADDR} "event" ${AUTONOMOUS_ARTIST_TRIGGER_EVENT} ${AUTONOMOUS_ARTIST_COMPONENT_FILENAME} ${AUTONOMOUS_ARTIST_ENV_VARS} ${AUTONOMOUS_ARTIST_CONFIG}

# === Autonomous Artist Simple Relay (nft -> minter) ===
new_workflow ${NFT_ADDR} ${MINTER_ADDR} "event" ${AUTONOMOUS_ARTIST_SIMPLE_RELAY_TRIGGER_EVENT} ${AUTONOMOUS_ARTIST_SIMPLE_RELAY_COMPONENT_FILENAME} "" ${AUTONOMOUS_ARTIST_CONFIG}

$BASE_CMD manager set-evm --chain-name ${SUBMIT_CHAIN} --address `cast --to-checksum ${SERVICE_MANAGER_ADDR}`
$BASE_CMD validate > /dev/null

# inform aggregator if set
if [ -n "$AGGREGATOR_URL" ]; then
    wget -q --header="Content-Type: application/json" --post-data='{"service": '"$(cat ${FILE_LOCATION})"'}' ${AGGREGATOR_URL}/register-service -O -
fi

echo "Configuration file created at ${FILE_LOCATION}"
