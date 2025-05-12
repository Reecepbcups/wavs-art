import React, {
  createContext,
  useState,
  useContext,
  useEffect,
  ReactNode,
} from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { ContractTransactionResponse, ethers } from "ethers";
import { DEFAULT_MINT_PRICE } from "../constants";
import {
  getBrowserProviderWalletSigner,
  getMinterContract,
  getNftContract,
} from "@/utils/clients";

interface MintContextType {
  mintPrice: string;
  pendingMints: PendingMint[];
  ownedNfts: OwnedNft[];
  loadingMintPrice: boolean;
  loadingNfts: boolean;
  triggerMint: (prompt: string) => Promise<string | null>;
  refreshNfts: () => Promise<void>;
}

interface PendingMint {
  triggerId: string;
  prompt: string;
  timestamp: number;
  startProgress?: number; // Optional starting progress percentage (for animation continuity)
}

interface OwnedNft {
  tokenId: string;
  tokenURI: string;
  imageUrl: string | null;
  metadata: any;
}

export const MintContext = createContext<MintContextType>({
  mintPrice: "0",
  pendingMints: [],
  ownedNfts: [],
  loadingMintPrice: false,
  loadingNfts: false,
  triggerMint: async () => null,
  refreshNfts: async () => {},
});

export const useMint = () => useContext(MintContext);

interface MintProviderProps {
  children: ReactNode;
}

export const MintProvider: React.FC<MintProviderProps> = ({ children }) => {
  const [mintPrice, setMintPrice] = useState<string>("0");
  const [pendingMints, setPendingMints] = useState<PendingMint[]>([]);
  const [ownedNfts, setOwnedNfts] = useState<OwnedNft[]>([]);
  const [loadingMintPrice, setLoadingMintPrice] = useState(false);
  const [loadingNfts, setLoadingNfts] = useState(false);

  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  // Get the mint price from the contract
  const loadMintPrice = async () => {
    try {
      setLoadingMintPrice(true);
      const minterContract = getMinterContract();

      try {
        // First check if the contract exists by getting its code
        const code = await minterContract.getDeployedCode();

        if (!code || code === "0x") {
          console.error(
            `Contract does not exist at ${await minterContract.getAddress()}`
          );
          setMintPrice(DEFAULT_MINT_PRICE);
          return;
        }

        // If the contract exists, try to call mintPrice()
        const price = await minterContract.mintPrice();
        setMintPrice(ethers.formatEther(price));
      } catch (error) {
        console.error(
          "Error fetching mint price from contract, using default:",
          error
        );
        // Use default mint price as fallback
        setMintPrice(DEFAULT_MINT_PRICE);
      }
    } catch (error) {
      console.error("Error loading mint price:", error);
      // Use default mint price as fallback
      setMintPrice(DEFAULT_MINT_PRICE);
    } finally {
      setLoadingMintPrice(false);
    }
  };

  // Load pending mints and owned NFTs
  const loadUserData = async () => {
    if (!isConnected || !address) {
      setPendingMints([]);
      setOwnedNfts([]);
      return;
    }

    try {
      setLoadingNfts(true);
      await Promise.all([loadPendingMints(), loadOwnedNfts()]);
    } catch (error) {
      console.error("Error loading user data:", error);
    } finally {
      setLoadingNfts(false);
    }
  };

  // Load pending mints that haven't been fulfilled yet
  const loadPendingMints = async () => {
    if (!address) return;

    try {
      // This would need to be implemented based on your backend/indexer
      // For demo purposes, we'll just use local storage
      const storedMints = localStorage.getItem(`pendingMints-${address}`);
      if (storedMints) {
        const parsedMints = JSON.parse(storedMints);

        // Filter out any that are too old (over 24 hours)
        const recent = parsedMints
          .filter(
            (mint: PendingMint) =>
              Date.now() - mint.timestamp < 24 * 60 * 60 * 1000
          )
          .map((mint: PendingMint) => {
            // Make sure startProgress is defined
            if (mint.startProgress === undefined) {
              mint.startProgress = 0;
            }
            return mint;
          });

        setPendingMints(recent);
        localStorage.setItem(`pendingMints-${address}`, JSON.stringify(recent));
      }
    } catch (error) {
      console.error("Error loading pending mints:", error);
    }
  };

  // Load user's owned NFTs
  const loadOwnedNfts = async () => {
    if (!address) return;

    try {
      const nftContract = getNftContract();
      if (!nftContract) return;

      const balance = await nftContract.balanceOf(address);
      const tokenCount = Number(balance);

      const nfts: OwnedNft[] = [];

      for (let i = 0; i < tokenCount; i++) {
        const tokenId = await nftContract.tokenOfOwnerByIndex(address, i);
        const tokenURI = await nftContract.tokenURI(tokenId);

        let metadata = null;
        let imageUrl = null;

        try {
          // Assume tokenURI is either IPFS or HTTP URL
          const isIpfs = tokenURI.startsWith("ipfs://");
          const metadataUrl = isIpfs
            ? tokenURI.replace(
                "ipfs://",
                "https://gateway.lighthouse.storage/ipfs/"
              )
            : tokenURI;

          const response = await fetch(metadataUrl);
          metadata = await response.json();

          if (metadata.image) {
            imageUrl = metadata.image.startsWith("ipfs://")
              ? metadata.image.replace(
                  "ipfs://",
                  "https://gateway.lighthouse.storage/ipfs/"
                )
              : metadata.image;
          }
        } catch (error) {
          console.error(`Error fetching metadata for token ${tokenId}:`, error);
        }

        nfts.push({
          tokenId: tokenId.toString(),
          tokenURI,
          imageUrl,
          metadata,
        });
      }

      setOwnedNfts(nfts);
    } catch (error) {
      console.error("Error loading owned NFTs:", error);
    }
  };

  // Trigger a new mint
  const triggerMint = async (prompt: string): Promise<string | null> => {
    if (!address || !isConnected || !walletClient || !publicClient) return null;

    // Create contract instance with ethers
    const { provider, signer } = await getBrowserProviderWalletSigner();
    const minterContract = getMinterContract(undefined, signer);
    const nftContract = getNftContract(undefined, signer);

    try {
      // Create ethers signer

      // Check if the contract exists
      const bytecode = await minterContract.getDeployedCode();
      if (!bytecode || bytecode === "0x") {
        throw new Error(
          `Contract does not exist at ${await minterContract.getAddress()}. Please make sure the contracts are deployed to your local network.`
        );
      }

      // Get the mint price from the contract
      let price;
      try {
        price = await minterContract.mintPrice();
      } catch (error) {
        console.error(
          "Error fetching mint price from contract, using default:",
          error
        );
        // Use default mint price as fallback
        price = ethers.parseEther(DEFAULT_MINT_PRICE);
      }

      // Check wallet balance
      const balance = await provider.getBalance(address);
      if (balance < price) {
        const formatBalance = ethers.formatEther(balance);
        const formatPrice = ethers.formatEther(price);
        console.error(
          `Insufficient balance: ${formatBalance} ETH, needed: ${formatPrice} ETH (not including gas)`
        );

        // Get the current chain to provide specific guidance
        const chainId = publicClient.chain.id;
        const chainName = publicClient.chain.name.toLowerCase();
        let faucetInfo = "";

        // Add network-specific information
        if (
          chainId === 31337 || // Anvil default
          chainId === 1337 || // Ganache/Hardhat default
          chainName.includes("local") ||
          chainName.includes("anvil") ||
          chainName.includes("hardhat") ||
          chainName.includes("localhost")
        ) {
          // Local Anvil/Hardhat environment
          faucetInfo =
            "For Anvil/local node: Use `anvil --balance 10000` to increase starting balance or send ETH to your account with `cast send --value 1ether <your-address> --private-key <anvil-private-key>`";
        } else if (chainId === 1) {
          // Mainnet - no faucets
          faucetInfo = "You'll need to purchase ETH from an exchange.";
        } else if (chainId === 5) {
          // Goerli
          faucetInfo = "Get test ETH from goerlifaucet.com";
        } else if (chainId === 11155111) {
          // Sepolia
          faucetInfo = "Get test ETH from sepoliafaucet.com";
        } else if (chainId === 80001) {
          // Mumbai
          faucetInfo = "Get test MATIC from mumbai.polygonscan.com/faucet";
        } else {
          // Generic message for other networks
          faucetInfo =
            "Search for a faucet for your current network to get test tokens.";
        }

        throw new Error(
          `Insufficient balance: You have ${formatBalance} ETH, but need at least ${formatPrice} ETH plus gas fees. ${faucetInfo}`
        );
      }

      // Check if we're in a local/development environment for additional debugging
      const isLocalEnv = true; // Always show debugging in development
      console.log("Chain ID:", publicClient.chain.id);
      console.log("Chain Name:", publicClient.chain.name);

      // For local environments, log more debugging info
      if (isLocalEnv) {
        console.log("Local environment detected, logging debug info:");
        console.log("Chain ID:", publicClient.chain.id);
        console.log("Chain Name:", publicClient.chain.name);
        console.log(
          "Minter Contract Address:",
          await minterContract.getAddress()
        );
        console.log("NFT Contract Address:", await nftContract.getAddress());
        console.log("Connected Address:", address);
        console.log("Mint Price (wei):", price.toString());
        console.log(
          "Balance (wei):",
          (await provider.getBalance(address)).toString()
        );

        try {
          // Try to read contract bytecode to check if it exists
          const minterBytecode = await minterContract.getDeployedCode();
          const nftBytecode = await nftContract.getDeployedCode();

          console.log(
            "Minter Contract exists?",
            !!minterBytecode && minterBytecode !== "0x"
          );
          console.log(
            "NFT Contract exists?",
            !!nftBytecode && nftBytecode !== "0x"
          );

          if (minterBytecode === "0x") {
            console.error(
              "⚠️ MINTER CONTRACT DOES NOT EXIST at address:",
              await minterContract.getAddress()
            );
            console.log(
              "Deploy the contract with: forge script script/Deploy.s.sol:Deploy --rpc-url http://localhost:8545 --broadcast"
            );
          }

          if (nftBytecode === "0x") {
            console.error(
              "⚠️ NFT CONTRACT DOES NOT EXIST at address:",
              await nftContract.getAddress()
            );
          }

          // Show a way to deploy with the specific contract addresses
          console.log(
            "\nTo deploy the contracts to these exact addresses, run the following commands:"
          );
          console.log(`1. Start anvil with specific accounts:
           anvil --accounts 2 --balance 10000 --chain-id 1337`);
          console.log(`2. Deploy the contracts with the specific addresses:
           forge script script/Deploy.s.sol:Deploy --rpc-url http://localhost:8545 --broadcast`);
          console.log(
            "\nAfter deployment, check if the contracts were deployed to the expected addresses."
          );
        } catch (e) {
          console.error("Error checking contract bytecode:", e);
        }
      }

      const feeData = await provider.getFeeData();
      console.log("Fee data:", feeData);

      // Execute the transaction - ensure gas params are properly set
      const options: any = {
        value: price,
        gasLimit: 300000,
      };

      // Only add maxFeePerGas and maxPriorityFeePerGas if they exist
      if (feeData.maxFeePerGas) {
        options.maxFeePerGas = feeData.maxFeePerGas;
      }
      if (feeData.maxPriorityFeePerGas) {
        options.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      }

      const tx: ContractTransactionResponse = await minterContract.triggerMint(
        prompt,
        options
      );

      console.log("Tx:", tx);

      // Wait for the transaction to be mined
      const receipt = await tx.wait();

      console.log("Receipt:", receipt);

      // Find the WavsNftTrigger event in the logs
      const event = receipt?.logs.length
        ? minterContract.interface.parseLog(receipt.logs[0])
        : null;
      if (!event || event.name !== "WavsNftTrigger") return null;

      const triggerId = event.args.triggerId.toString();

      // Store pending mint in local storage
      const newPendingMint = {
        triggerId,
        prompt,
        timestamp: Date.now(),
        startProgress: 0, // Start at 0% progress
      };

      const updatedPendingMints = [...pendingMints, newPendingMint];
      setPendingMints(updatedPendingMints);
      localStorage.setItem(
        `pendingMints-${address}`,
        JSON.stringify(updatedPendingMints)
      );

      return triggerId;
    } catch (error) {
      console.error("Error triggering mint:", error);

      // Check for specific error types and provide better feedback
      if (error instanceof Error) {
        // For insufficient balance errors, propagate our custom error
        if (error.message.includes("Insufficient balance")) {
          throw error;
        }

        // For contract not found errors
        if (
          error.message.includes("call revert exception") &&
          error.message.includes('method="mintPrice()"')
        ) {
          console.error("Contract method not available. This usually means:");
          console.error(
            "1. The contract doesn't exist at the specified address"
          );
          console.error(
            "2. The contract at that address doesn't have the expected functions"
          );
          console.error("3. You might be connected to the wrong network");

          const errorMsg = `Contract error: The mintPrice() function is not available. Make sure the contract is deployed at ${await minterContract.getAddress()} on your current network.`;
          throw new Error(errorMsg);
        }
      }

      return null;
    }
  };

  // Refresh NFTs
  const refreshNfts = async (): Promise<void> => {
    await loadUserData();
  };

  // Set up event listeners for MintFulfilled events
  useEffect(() => {
    const minterContract = getMinterContract();
    if (!address || !publicClient) return;

    const mintFulfilledFilter = minterContract.filters.MintFulfilled();

    const handleMintFulfilled = async (triggerId: ethers.BigNumberish) => {
      const triggerIdStr = triggerId.toString();

      // Check if this triggerId matches any of our pending mints
      const matchingMint = pendingMints.find(
        (m) => m.triggerId === triggerIdStr
      );
      if (!matchingMint) return;

      // Remove this mint from pending
      const updatedPendingMints = pendingMints.filter(
        (m) => m.triggerId !== triggerIdStr
      );
      setPendingMints(updatedPendingMints);
      localStorage.setItem(
        `pendingMints-${address}`,
        JSON.stringify(updatedPendingMints)
      );

      // Refresh owned NFTs to include the new one
      await loadOwnedNfts();
    };

    minterContract.on(mintFulfilledFilter, handleMintFulfilled);

    return () => {
      minterContract.off(mintFulfilledFilter, handleMintFulfilled);
    };
  }, [pendingMints, address, publicClient]);

  // Listen for NFT mint events to refresh owned NFTs
  useEffect(() => {
    const nftContract = getNftContract();
    if (!nftContract || !address || !publicClient) return;

    const wavsNftMintFilter = nftContract.filters.WavsNftMint(address);

    const handleNftMint = async () => {
      await loadOwnedNfts();
    };

    nftContract.on(wavsNftMintFilter, handleNftMint);

    return () => {
      nftContract.off(wavsNftMintFilter, handleNftMint);
    };
  }, [address, publicClient]);

  // Load initial data
  useEffect(() => {
    loadMintPrice();
  }, []);

  useEffect(() => {
    if (isConnected) {
      loadUserData();
    }
  }, [isConnected, address]);

  const value = {
    mintPrice,
    pendingMints,
    ownedNfts,
    loadingMintPrice,
    loadingNfts,
    triggerMint,
    refreshNfts,
  };

  return <MintContext.Provider value={value}>{children}</MintContext.Provider>;
};
