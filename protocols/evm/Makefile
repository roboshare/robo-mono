.PHONY: build deploy generate-abis generate-protocol-config get-address account chain compile flatten fork format lint test verify

DEPLOY_SCRIPT ?= script/Deploy.s.sol
VERIFY_RUNNER ?= script/VerifyAll.s.sol
VERIFY_TARGET_SCRIPT ?= Deploy.s.sol
LIVE_BROADCAST_FLAGS ?= --slow --batch-size 1

# setup wallet for anvil
setup-anvil-wallet:
	shx rm -f "$$HOME/.foundry/keystores/scaffold-eth-default"
	cast wallet import --private-key 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 --unsafe-password 'localhost' scaffold-eth-default

# Start local chain with state persistence
chain: setup-anvil-wallet
	anvil --host 0.0.0.0 --state ./anvil-state.json --state-interval 5

# Start local chain without persistence (fresh state)
chain-fresh: setup-anvil-wallet
	anvil --host 0.0.0.0 --base-fee 1000000000 --gas-limit 30000000

# Start a fork
fork: setup-anvil-wallet
	anvil --host 0.0.0.0 --fork-url ${FORK_URL} --chain-id 31337

# Deploy the contracts
deploy:
	@if [ ! -f "$(DEPLOY_SCRIPT)" ]; then \
		echo "Error: Deploy script '$(DEPLOY_SCRIPT)' not found"; \
		exit 1; \
	fi
	@if [ "$(RPC_URL)" = "localhost" ]; then \
		if [ "$(ETH_KEYSTORE_ACCOUNT)" = "scaffold-eth-default" ]; then \
			forge script $(DEPLOY_SCRIPT) $(SCRIPT_SIG_ARGS) --rpc-url localhost --password localhost --broadcast --legacy --ffi; \
		else \
			forge script $(DEPLOY_SCRIPT) $(SCRIPT_SIG_ARGS) --rpc-url localhost --broadcast --legacy --ffi; \
		fi \
	else \
		forge script $(DEPLOY_SCRIPT) $(SCRIPT_SIG_ARGS) --rpc-url $(RPC_URL) --broadcast --legacy --ffi $(LIVE_BROADCAST_FLAGS); \
	fi

# Deploy and generate ABIs
deploy-and-generate-abis: deploy generate-abis 

# Generate TypeScript ABIs
generate-abis:
	node scripts-js/generateTsAbis.js
	node scripts-js/generateFrontendProtocolConfig.js

# Generate frontend protocol constants and deployment metadata
generate-protocol-config:
	node scripts-js/generateFrontendProtocolConfig.js

# List account
account:
	@node scripts-js/checkAccountBalance.js

# Get address of a keystore
get-address:
	@cast wallet address --account $(ACCOUNT_NAME)

# Compile contracts
compile:
	forge compile

# Flatten contracts
flatten:
	forge flatten

# Format code
format:
	forge fmt && prettier --write ./scripts-js/**/*.js

# Lint code
lint:
	forge fmt --check && prettier --check ./scripts-js/**/*.js

# Run tests
test:
	forge test

# Verify contracts
verify:
	forge build
	BROADCAST_SCRIPT=$(VERIFY_TARGET_SCRIPT) forge script $(VERIFY_RUNNER) --ffi --rpc-url $(RPC_URL)
