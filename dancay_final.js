const ethers = require('ethers');
const axios = require('axios');
const fs = require('fs').promises;
const { HttpsProxyAgent } = require('https-proxy-agent');
const colors = require('colors');

colors.enable();

function log(msg, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    switch (type) {
        case 'success':
            console.log(`[${timestamp}] [✓] ${msg}`.green);
            break;
        case 'custom':
            console.log(`[${timestamp}] [*] ${msg}`.magenta);
            break;
        case 'error':
            console.log(`[${timestamp}] [✗] ${msg}`.red);
            break;
        case 'warning':
            console.log(`[${timestamp}] [!] ${msg}`.yellow);
            break;
        default:
            console.log(`[${timestamp}] [ℹ] ${msg}`.blue);
    }
}

const networkConfig = {
    name: "Pharos Testnet",
    chainId: 688688,
    rpcUrl: "https://testnet.dplabs-internal.com",
};

const SWAP_ROUTER_ADDRESS = "0x1A4DE519154Ae51200b0Ad7c90F7faC75547888a";
const LP_ROUTER_ADDRESS = "0xf8a1d4ff0f9b9af7ce58e1fc1833688f3bfd6115";
const USDC_POOL_ADDRESS = "0x0373a059321219745aee4fad8a942cf088be3d0e";
const USDT_POOL_ADDRESS = "0x70118b6eec45329e0534d849bc3e588bb6752527";
const WPHRS_ADDRESS = "0x76aaada469d23216be5f7c596fa25f282ff9b364";
const USDC_ADDRESS = "0xad902cf99c2de2f1ba5ec4d642fd7e49cae9ee37";
const USDT_ADDRESS = "0xed59de2d7ad9c043442e381231ee3646fc3c2939";

const SWAP_ROUTER_ABI = [
    "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
    "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
    "function exactOutputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountIn)",
    "function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)",
    "function exactOutput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum)) external payable returns (uint256 amountIn)",
    "function unwrapWETH9(uint256 amountMinimum, address recipient) external payable",
    "function refundETH() external payable",
    "function WETH9() external view returns (address)",
];

const LP_ROUTER_ABI = [
    "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)",
    "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX96, uint256 feeGrowthInside1LastX96, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const POOL_ABI = [
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function fee() view returns (uint24)",
    "function liquidity() view returns (uint128)",
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function transfer(address to, uint256 amount) returns (bool)",
];

const AMOUNT_IN = ethers.parseEther("0.001");
const AMOUNT_OUT_MINIMUM = 0n;
const FEE = 500;
const MAX_RETRIES = 1;
const SWAP_ROUNDS = 20;
const FINAL_SWAP_PERCENTAGE = 40;
const LP_ROUNDS = 10;

async function checkProxyIP(proxy) {
    try {
        const proxyAgent = new HttpsProxyAgent(proxy);
        const response = await axios.get('https://api.ipify.org?format=json', {
            httpsAgent: proxyAgent
        });
        if (response.status === 200) {
            return response.data.ip;
        } else {
            throw new Error(`Unable to check proxy IP. Status code: ${response.status}`);
        }
    } catch (error) {
        throw new Error(`Error checking proxy IP: ${error.message}`);
    }
}

async function readUserAgents() {
    try {
        const userAgents = (await fs.readFile('agent.txt', 'utf8'))
            .split('\n')
            .map(agent => agent.trim())
            .filter(agent => agent);
        return userAgents;
    } catch (error) {
        log(`Error reading agent.txt: ${error}`, 'error');
        throw error;
    }
}

async function readInputFiles() {
    try {
        const privateKeys = (await fs.readFile('wallet.txt', 'utf8'))
            .split('\n')
            .map(key => key.trim())
            .filter(key => key) 
            .map(key => {
                if (!key.startsWith('0x')) {
                    return '0x' + key;
                }
                return key;
            })
            .filter(key => key.length === 66); 

        const proxies = privateKeys.map(() => ''); // proxy.txt not used
        const userAgents = await readUserAgents();
        return { privateKeys, proxies, userAgents };
    } catch (error) {
        log(`Error reading input files: ${error}`, "error");
        throw error;
    }
}

async function getWalletsAndSignatures(privateKeys) {
    try {
        const wallets = privateKeys.map(privateKey => {
            const wallet = new ethers.Wallet(privateKey);
            return { wallet, privateKey };
        });
        const signatures = await Promise.all(
            wallets.map(async ({ wallet }) => {
                const message = "pharos";
                return await wallet.signMessage(message);
            })
        );
        return wallets.map(({ wallet, privateKey }, index) => ({
            address: wallet.address,
            privateKey,
            signature: signatures[index]
        }));
    } catch (error) {
        log(`Error creating wallets or signatures: ${error}`, 'error');
        throw error;
    }
}

async function login(address, signature, inviteCode, proxy, userAgent) {
    const url = `https://api.pharosnetwork.xyz/user/login?address=${address}&signature=${signature}&invite_code=${inviteCode}`;
    try {
        const proxyAgent = new HttpsProxyAgent(proxy);
        const response = await axios.post(url, {}, {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Authorization': 'Bearer null',
                'Origin': 'https://testnet.pharosnetwork.xyz',
                'Referer': 'https://testnet.pharosnetwork.xyz/',
                'User-Agent': userAgent 
            },
            httpsAgent: proxyAgent
        });
        return response.data;
    } catch (error) {
        log(`Login API error for address ${address}: ${error.response?.data || error.message}`, 'error');
        throw error;
    }
}

async function getSignStatus(address, jwt, proxy, userAgent) {
    const url = `https://api.pharosnetwork.xyz/sign/status?address=${address}`;
    try {
        const proxyAgent = new HttpsProxyAgent(proxy);
        const response = await axios.get(url, {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Authorization': `Bearer ${jwt}`,
                'Origin': 'https://testnet.pharosnetwork.xyz',
                'Referer': 'https://testnet.pharosnetwork.xyz/',
                'User-Agent': userAgent 
            },
            httpsAgent: proxyAgent
        });
        return response.data;
    } catch (error) {
        log(`Sign status API error for address ${address}: ${error.response?.data || error.message}`, 'error');
        throw error;
    }
}

async function getUserProfile(address, jwt, proxy, userAgent) {
    const url = `https://api.pharosnetwork.xyz/user/profile?address=${address}`;
    try {
        const proxyAgent = new HttpsProxyAgent(proxy);
        const response = await axios.get(url, {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Authorization': `Bearer ${jwt}`,
                'Origin': 'https://testnet.pharosnetwork.xyz',
                'Referer': 'https://testnet.pharosnetwork.xyz/',
                'User-Agent': userAgent
            },
            httpsAgent: proxyAgent
        });
        return response.data;
    } catch (error) {
        log(`User profile API error for address ${address}: ${error.response?.data || error.message}`, 'error');
        throw error;
    }
}

async function performSignIn(address, jwt, proxy, userAgent) {
    const url = `https://api.pharosnetwork.xyz/sign/in?address=${address}`;
    try {
        const proxyAgent = new HttpsProxyAgent(proxy);
        const response = await axios.post(url, {}, {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Authorization': `Bearer ${jwt}`,
                'Origin': 'https://testnet.pharosnetwork.xyz',
                'Referer': 'https://testnet.pharosnetwork.xyz/',
                'User-Agent': userAgent
            },
            httpsAgent: proxyAgent
        });
        return response.data;
    } catch (error) {
        log(`Sign-in API error for address ${address}: ${error.response?.data || error.message}`, 'error');
        throw error;
    }
}

async function checkFaucetStatus(address, jwt, proxy, userAgent) {
    const url = `https://api.pharosnetwork.xyz/faucet/status?address=${address}`;
    try {
        const proxyAgent = new HttpsProxyAgent(proxy);
        const response = await axios.get(url, {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Authorization': `Bearer ${jwt}`,
                'Origin': 'https://testnet.pharosnetwork.xyz',
                'Referer': 'https://testnet.pharosnetwork.xyz/',
                'User-Agent': userAgent
            },
            httpsAgent: proxyAgent
        });
        return response.data;
    } catch (error) {
        log(`Faucet status API error for address ${address}: ${error.response?.data || error.message}`, 'error');
        throw error;
    }
}

async function performDailyFaucet(address, jwt, proxy, userAgent) {
    const url = `https://api.pharosnetwork.xyz/faucet/daily?address=${address}`;
    try {
        const proxyAgent = new HttpsProxyAgent(proxy);
        const response = await axios.post(url, {}, {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Authorization': `Bearer ${jwt}`,
                'Origin': 'https://testnet.pharosnetwork.xyz',
                'Referer': 'https://testnet.pharosnetwork.xyz/',
                'User-Agent': userAgent
            },
            httpsAgent: proxyAgent
        });
        return response.data;
    } catch (error) {
        log(`Daily faucet API error for address ${address}: ${error.response?.data || error.message}`, 'error');
        throw error;
    }
}

async function checkPool(provider, poolAddress, expectedToken0, expectedToken1) {
    const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
    let token0, token1, fee, liquidity, sqrtPriceX96;
    try {
        token0 = await poolContract.token0();
        log(`Token0 của pool: ${token0}`);
    } catch (error) {
        log(`Unable to fetch token0: ${error.message}`, "error");
        throw new Error("Invalid pool: không lấy được token0");
    }
    try {
        token1 = await poolContract.token1();
        log(`Token1 của pool: ${token1}`);
    } catch (error) {
        log(`Unable to fetch token1: ${error.message}`, "error");
        throw new Error("Invalid pool: không lấy được token1");
    }
    try {
        fee = Number(await poolContract.fee());
        log(`Phí pool: ${fee} (${fee / 10000}%)`);
    } catch (error) {
        log(`Unable to fetch pool fee: ${error.message}`, "error");
        throw new Error("Invalid pool: không lấy được phí");
    }
    try {
        liquidity = await poolContract.liquidity();
        log(`Thanh khoản pool: ${liquidity.toString()}`);
    } catch (error) {
        log(`Unable to fetch liquidity: ${error.message}`, "error");
        liquidity = null;
    }
    try {
        const slot0 = await poolContract.slot0();
        sqrtPriceX96 = slot0.sqrtPriceX96;
        log(`Giá sqrtPriceX96 của pool: ${sqrtPriceX96.toString()}`);
    } catch (error) {
        log(`Unable to fetch sqrtPriceX96: ${error.message}`, "error");
        sqrtPriceX96 = null;
    }
    const hasExpectedToken0 =
        token0.toLowerCase() === expectedToken0.toLowerCase() ||
        token0.toLowerCase() === expectedToken1.toLowerCase();
    const hasExpectedToken1 =
        token1.toLowerCase() === expectedToken0.toLowerCase() ||
        token1.toLowerCase() === expectedToken1.toLowerCase();
    if (!hasExpectedToken0 || !hasExpectedToken1) {
        log(`Pool missing expected tokens: ${expectedToken0} và ${expectedToken1}`, "warning");
    }
    return { token0, token1, fee, liquidity, sqrtPriceX96 };
}

async function getTokenDecimals(tokenAddress, provider) {
    try {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const decimals = await tokenContract.decimals();
        return decimals;
    } catch (error) {
        log(`Unable to get token decimals cho token ${tokenAddress}: ${error.message}`, "error");
        return 18;
    }
}

async function getTokenBalance(tokenAddress, walletAddress, provider) {
    try {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const balance = await tokenContract.balanceOf(walletAddress);
        return balance;
    } catch (error) {
        log(`Unable to fetch token balance cho token ${tokenAddress}: ${error.message}`, "error");
        return 0n;
    }
}

async function approveToken(tokenAddress, spenderAddress, amount, wallet) {
    try {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        const currentAllowance = await tokenContract.allowance(wallet.address, spenderAddress);
        if (currentAllowance >= amount) {
            log(`Sufficient approval exists cho token ${tokenAddress}`, "success");
            return true;
        }
        log(`Approving ${amount.toString()} token ${tokenAddress} cho ${spenderAddress}`, "info");
        const tx = await tokenContract.approve(spenderAddress, amount);
        const receipt = await tx.wait();
        log(`Approval successful. Gas sử dụng: ${receipt.gasUsed.toString()}`, "success");
        return true;
    } catch (error) {
        log(`Approval failed cho token ${tokenAddress}: ${error.message}`, "error");
        return false;
    }
}

async function swapNativeToToken(wallet, tokenOutAddress, amountIn, swapRouter, fee = FEE) {
    const params = {
        tokenIn: WPHRS_ADDRESS,
        tokenOut: tokenOutAddress,
        fee: fee,
        recipient: wallet.address,
        amountIn: amountIn,
        amountOutMinimum: AMOUNT_OUT_MINIMUM,
        sqrtPriceLimitX96: 0,
    };
    const iface = new ethers.Interface(SWAP_ROUTER_ABI);
    const exactInputSingleData = iface.encodeFunctionData("exactInputSingle", [params]);
    const refundETHData = iface.encodeFunctionData("refundETH", []);
    const multicallData = [exactInputSingleData, refundETHData];
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            let gasLimit;
            try {
                gasLimit = await swapRouter.multicall.estimateGas(multicallData, { value: amountIn });
                log(`Estimated gas: ${gasLimit.toString()}`, "info");
                gasLimit = gasLimit * 200n / 100n;
            } catch (gasError) {
                log(`Estimated gas thất bại: ${gasError.message}`, "warning");
                gasLimit = 3000000n;
            }
            const tx = await swapRouter.multicall(multicallData, { value: amountIn, gasLimit });
            log(`Transaction sent: ${tx.hash}`, "info");
            const receipt = await tx.wait();
            log(`Completed. Block: ${receipt.blockNumber}, Gas sử dụng: ${receipt.gasUsed.toString()}`, "success");
            return true;
        } catch (error) {
            log(`Retry attempt ${attempt}/${MAX_RETRIES} thất bại: ${error.message}`, "error");
            if (attempt === MAX_RETRIES) {
                log(`All retries exhausted cho multicall.`, "error");
            } else {
                log(`Retrying in 2 giây...`, "info");
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    return false;
}

async function swapTokenToPHRS(provider, wallet, tokenAddress, percentage = 100) {
    try {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        const swapRouter = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
        const tokenBalance = await tokenContract.balanceOf(wallet.address);
        const tokenDecimals = await getTokenDecimals(tokenAddress, provider);
        log(`Balance ${tokenAddress}: ${ethers.formatUnits(tokenBalance, tokenDecimals)}`, "info");
        if (tokenBalance === 0n) {
            log(`No balance ${tokenAddress} để đổi về PHRS`, "warning");
            return false;
        }
        const amountToSwap = tokenBalance * BigInt(percentage) / 100n;
        log(`Swapping ${ethers.formatUnits(amountToSwap, tokenDecimals)} ${tokenAddress} về PHRS (${percentage}% số dư)`, "info");
        const approveSuccess = await approveToken(tokenAddress, SWAP_ROUTER_ADDRESS, amountToSwap, wallet);
        if (!approveSuccess) {
            log(`Failed to approve ${tokenAddress} để swap`, "error");
            return false;
        }
        let fee = FEE;
        if (tokenAddress.toLowerCase() === USDT_ADDRESS.toLowerCase()) {
            const poolContract = new ethers.Contract(USDT_POOL_ADDRESS, POOL_ABI, provider);
            try {
                fee = Number(await poolContract.fee());
                log(`Using pool fee USDT: ${fee}`, "info");
            } catch (error) {
                log(`Unable to fetch pool fee pool USDT, dùng mặc định: ${fee}`, "warning");
            }
        } else if (tokenAddress.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
            const poolContract = new ethers.Contract(USDC_POOL_ADDRESS, POOL_ABI, provider);
            try {
                fee = Number(await poolContract.fee());
                log(`Using pool fee USDC: ${fee}`, "info");
            } catch (error) {
                log(`Unable to fetch pool fee pool USDC, dùng mặc định: ${fee}`, "warning");
            }
        }
        const params = {
            tokenIn: tokenAddress,
            tokenOut: WPHRS_ADDRESS,
            fee: fee,
            recipient: wallet.address,
            amountIn: amountToSwap,
            amountOutMinimum: AMOUNT_OUT_MINIMUM,
            sqrtPriceLimitX96: 0,
        };
        const iface = new ethers.Interface(SWAP_ROUTER_ABI);
        const exactInputSingleData = iface.encodeFunctionData("exactInputSingle", [params]);
        const unwrapData = iface.encodeFunctionData("unwrapWETH9", [0, wallet.address]);
        const multicallData = [exactInputSingleData, unwrapData];
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                let gasLimit;
                try {
                    gasLimit = await swapRouter.multicall.estimateGas(multicallData);
                    log(`Estimated gas: ${gasLimit.toString()}`, "info");
                    gasLimit = gasLimit * 200n / 100n;
                } catch (gasError) {
                    log(`Estimated gas thất bại: ${gasError.message}`, "warning");
                    gasLimit = 3000000n;
                }
                const tx = await swapRouter.multicall(multicallData, { gasLimit });
                log(`Giao dịch gửi cho ${tokenAddress} -> PHRS: ${tx.hash}`, "info");
                const receipt = await tx.wait();
                log(`Completed swap ${tokenAddress} -> PHRS. Block: ${receipt.blockNumber}, Gas sử dụng: ${receipt.gasUsed.toString()}`, "success");
                return true;
            } catch (error) {
                log(`Retry attempt ${attempt}/${MAX_RETRIES} thất bại: ${error.message}`, "error");
                if (attempt === MAX_RETRIES) {
                    log(`All retries exhausted cho multicall.`, "error");
                } else {
                    log(`Retrying in 2 giây...`, "info");
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
        return false;
    } catch (error) {
        log(`Swap error ${tokenAddress} về PHRS: ${error.message}`, "error");
        return false;
    }
}

async function performMultipleSwaps(provider, wallet, swapCount) {
    log(`==== Thực hiện ${swapCount} lần swap ====`, "custom");
    let successCount = 0;
    let currentSwap = 0;
    const tokens = [
        { address: USDC_ADDRESS, pool: USDC_POOL_ADDRESS, name: "USDC" },
        { address: USDT_ADDRESS, pool: USDT_POOL_ADDRESS, name: "USDT" },
    ];
    const swapRouter = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
    let swapHistory = [];
    let phrsBalance = await provider.getBalance(wallet.address);
    log(`Balance PHRS ban đầu: ${ethers.formatEther(phrsBalance)} PHRS`, "info");
    while (currentSwap < swapCount) {
        log(`Swap lần ${currentSwap + 1}/${swapCount} ---`, "custom");
        const token = tokens[currentSwap % 2];
        try {
            const tokenBalance = await getTokenBalance(token.address, wallet.address, provider);
            const tokenDecimals = await getTokenDecimals(token.address, provider);
            log(`Balance ${token.name}: ${ethers.formatUnits(tokenBalance, tokenDecimals)}`, "info");
            if (tokenBalance > 0n && (currentSwap % 4 === 1 || currentSwap % 4 === 3)) {
                log(`Swapping ${token.name} -> PHRS`, "info");
                const success = await swapTokenToPHRS(provider, wallet, token.address, 100);
                if (success) {
                    swapHistory.push({ type: `${token.name}->PHRS`, token: token.address });
                    currentSwap++;
                    successCount++;
                    log(`Completed swap ${currentSwap}: ${token.name} -> PHRS`, "success");
                } else {
                    log(`Không thể swap ${token.name} -> PHRS`, "error");
                }
            } else if (phrsBalance >= AMOUNT_IN) {
                log(`Swapping PHRS -> ${token.name}`, "info");
                const success = await swapNativeToToken(wallet, token.address, AMOUNT_IN, swapRouter, FEE);
                if (success) {
                    swapHistory.push({ type: `PHRS->${token.name}`, token: token.address });
                    currentSwap++;
                    successCount++;
                    log(`Completed swap ${currentSwap}: PHRS -> ${token.name}`, "success");
                } else {
                    log(`Không thể swap PHRS -> ${token.name}`, "error");
                }
            } else {
                log(`Không đủ số dư PHRS (${ethers.formatEther(phrsBalance)}) để swap PHRS -> ${token.name}`, "warning");
                break;
            }
            phrsBalance = await provider.getBalance(wallet.address);
            log(`Balance PHRS hiện tại: ${ethers.formatEther(phrsBalance)} PHRS`, "info");
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            log(`Lỗi ở swap ${currentSwap + 1}: ${error.message}`, "error");
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    log("=== Đổi tất cả token còn lại về PHRS ===", "custom");
    for (const token of tokens) {
        const tokenBalance = await getTokenBalance(token.address, wallet.address, provider);
        const tokenDecimals = await getTokenDecimals(token.address, provider);
        log(`Balance ${token.name}: ${ethers.formatUnits(tokenBalance, tokenDecimals)}`, "info");
        if (tokenBalance > 0n) {
            log(`Swapping tất cả ${token.name} về PHRS`, "info");
            const success = await swapTokenToPHRS(provider, wallet, token.address, 100);
            if (success) {
                log(`Đổi ${token.name} về PHRS thành công`, "success");
            } else {
                log(`Không thể đổi ${token.name} về PHRS`, "error");
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    log(`Completed ${successCount}/${swapCount} lần swap`, "custom");
    log(`Lịch sử swap: ${JSON.stringify(swapHistory)}`, "info");
    return successCount > 0;
}

async function performFinalSwaps(provider, wallet) {
    log(`==== Chuẩn bị thêm thanh khoản ====`, "custom");
    try {
        const phrsBalance = await provider.getBalance(wallet.address);
        log(`Balance PHRS hiện tại: ${ethers.formatEther(phrsBalance)} PHRS`, "info");
        if (phrsBalance <= ethers.parseEther("0.001")) {
            log("Không đủ số dư PHRS để thực hiện swap", "warning");
            return false;
        }
        const reserveForGas = ethers.parseEther("0.001");
        const swappableBalance = phrsBalance - reserveForGas;
        const amountToSwap = swappableBalance * BigInt(FINAL_SWAP_PERCENTAGE) / 100n;
        log(`Đổi ${ethers.formatEther(amountToSwap)} PHRS (40% số dư) sang mỗi token`, "info");
        const swapRouter = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
        const toUsdcSuccess = await swapNativeToToken(wallet, USDC_ADDRESS, amountToSwap, swapRouter, FEE);
        return toUsdcSuccess;
    } catch (error) {
        log(`Lỗi khi đổi 40% số dư: ${error.message}`, "error");
        return false;
    }
}

function priceToClosestTick(price) {
    return Math.round(Math.log(price) / Math.log(1.0001));
}

async function addLiquidity(provider, wallet, token0, token1, poolAddress, amount0, amount1) {
    try {
        log(`Đang cung cấp thanh khoản cho ${token0}/${token1}`, "info");
        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
        const actualToken0 = await pool.token0();
        const actualToken1 = await pool.token1();
        log(`Token0 từ pool: ${actualToken0}`, "info");
        log(`Token1 từ pool: ${actualToken1}`, "info");
        const actualFee = Number(await pool.fee());
        log(`Phí pool chính xác: ${actualFee} (${actualFee / 10000}%)`, "info");
        
        let sortedAmount0, sortedAmount1;
        if (token0.toLowerCase() === actualToken0.toLowerCase()) {
            sortedAmount0 = amount0;
            sortedAmount1 = amount1;
        } else {
            sortedAmount0 = amount1;
            sortedAmount1 = amount0;
        }
        
        const slot0 = await pool.slot0();
        const currentTick = Number(slot0.tick);
        
        const tickLower = -887270; 
        const tickUpper = 887270;  
        
        log(`Tick hiện tại: ${currentTick}, sử dụng khoảng FULL RANGE: ${tickLower} đến ${tickUpper}`, "info");
        
        const approved0 = await approveToken(actualToken0, LP_ROUTER_ADDRESS, sortedAmount0, wallet);
        if (!approved0) {
            log(`Failed to approve ${actualToken0}`, "error");
            return false;
        }
        
        const approved1 = await approveToken(actualToken1, LP_ROUTER_ADDRESS, sortedAmount1, wallet);
        if (!approved1) {
            log(`Failed to approve ${actualToken1}`, "error");
            return false;
        }
        
        const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
        const amount0Min = 0n;
        const amount1Min = 0n;
        
        const lpRouter = new ethers.Contract(LP_ROUTER_ADDRESS, LP_ROUTER_ABI, wallet);
        const params = {
            token0: actualToken0,
            token1: actualToken1,
            fee: actualFee,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: sortedAmount0,
            amount1Desired: sortedAmount1,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            recipient: wallet.address,
            deadline: deadline,
        };
        
        log(`Tham số cung cấp thanh khoản: amount0Desired=${params.amount0Desired.toString()}, amount1Desired=${params.amount1Desired.toString()}, amount0Min=${params.amount0Min.toString()}, amount1Min=${params.amount1Min.toString()}, deadline=${new Date(params.deadline * 1000).toLocaleString()}`, "info");
        
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                if (attempt > 1) {
                    const reductionFactor = BigInt(Math.pow(0.8, attempt - 1) * 1000) / 1000n;
                    params.amount0Desired = sortedAmount0 * reductionFactor / 1000n;
                    params.amount1Desired = sortedAmount1 * reductionFactor / 1000n;
                    log(`Giảm số lượng xuống ${reductionFactor / 10}%: amount0=${params.amount0Desired}, amount1=${params.amount1Desired}`, "info");
                }
                
                let gasLimit;
                try {
                    gasLimit = await lpRouter.mint.estimateGas(params);
                    log(`Estimated gas: ${gasLimit.toString()}`, "info");
                    gasLimit = gasLimit * 200n / 100n;
                } catch (gasError) {
                    log(`Estimated gas thất bại: ${gasError.message}`, "warning");
                    log(`Debug params: ${JSON.stringify({
                        token0: params.token0,
                        token1: params.token1,
                        fee: params.fee,
                        tickLower: params.tickLower,
                        tickUpper: params.tickUpper
                    })}`, "warning");
                    gasLimit = 5000000n; 
                }
                
                const tx = await lpRouter.mint(params, { gasLimit });
                log(`Giao dịch gửi để cung cấp thanh khoản: ${tx.hash}`, "info");
                const receipt = await tx.wait();
                
                let tokenId;
                try {
                    for (const log of receipt.logs) {
                        if (log.address.toLowerCase() === LP_ROUTER_ADDRESS.toLowerCase()) {
                            if (log.topics[0].includes("0xb94bf7c5")) {
                                tokenId = parseInt(log.topics[1], 16);
                                break;
                            }
                        }
                    }
                } catch (error) {
                    log(`Không lấy được token ID từ logs: ${error.message}`, "warning");
                }
                
                log(`Adding liquidity thành công! ${tokenId ? `Token ID: ${tokenId}` : ""}`, "success");
                log(`Gas sử dụng: ${receipt.gasUsed.toString()}`, "info");
                return true;
            } catch (error) {
                log(`Retry attempt ${attempt}/${MAX_RETRIES} thất bại khi cung cấp thanh khoản: ${error.message}`, "error");
                if (attempt === MAX_RETRIES) {
                    log(`All retries exhausted cung cấp thanh khoản.`, "error");
                } else {
                    log(`Retrying in 3 giây...`, "info");
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
        }
        return false;
    } catch (error) {
        log(`Lỗi khi cung cấp thanh khoản: ${error.message}`, "error");
        return false;
    }
}

async function performMultipleLPs(provider, wallet, token0, token1, poolAddress, lpCount) {
    log(`==== Adding liquidity cho ${token0}/${token1} (${lpCount} lần) ====`, "custom");
    try {
        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
        const actualToken0 = await pool.token0();
        const actualToken1 = await pool.token1();
        log(`Pool ${poolAddress} sử dụng:`, "info");
        log(`  Token0: ${actualToken0}`, "info");
        log(`  Token1: ${actualToken1}`, "info");
        
        const token0Balance = await getTokenBalance(actualToken0, wallet.address, provider);
        const token1Balance = await getTokenBalance(actualToken1, wallet.address, provider);
        const token0Decimals = await getTokenDecimals(actualToken0, provider);
        const token1Decimals = await getTokenDecimals(actualToken1, provider);
        
        log(`Balance token để cung cấp thanh khoản:`, "info");
        log(`  ${actualToken0}: ${ethers.formatUnits(token0Balance, token0Decimals)}`, "info");
        log(`  ${actualToken1}: ${ethers.formatUnits(token1Balance, token1Decimals)}`, "info");
        
        if (token0Balance === 0n || token1Balance === 0n) {
            log("Không đủ số dư token để cung cấp thanh khoản", "warning");
            return false;
        }
        
        let totalAmount0ForLP = (token0Balance * 80n) / 100n;
        let totalAmount1ForLP = (token1Balance * 80n) / 100n;
        
        let amount0PerLP = totalAmount0ForLP / BigInt(lpCount);
        let amount1PerLP = totalAmount1ForLP / BigInt(lpCount);
        
        log(`Lượng token ban đầu mỗi lần LP:`, "info");
        log(`  ${actualToken0}: ${ethers.formatUnits(amount0PerLP, token0Decimals)}`, "info");
        log(`  ${actualToken1}: ${ethers.formatUnits(amount1PerLP, token1Decimals)}`, "info");
        
        let successCount = 0;
        
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        
        for (let i = 0; i < lpCount; i++) {
            log(`--- Vòng cung cấp thanh khoản ${i + 1}/${lpCount} ---`, "custom");
            
            try {
                const currentToken0Balance = await getTokenBalance(actualToken0, wallet.address, provider);
                const currentToken1Balance = await getTokenBalance(actualToken1, wallet.address, provider);
                const useAmount0 = currentToken0Balance < amount0PerLP ? currentToken0Balance : amount0PerLP;
                const useAmount1 = currentToken1Balance < amount1PerLP ? currentToken1Balance : amount1PerLP;
                
                if (useAmount0 === 0n || useAmount1 === 0n) {
                    log("Bỏ qua vòng LP này do không đủ token", "warning");
                    continue;
                }
                
                log(`Số lượng token cho vòng LP ${i + 1}:`, "info");
                log(`  ${actualToken0}: ${ethers.formatUnits(useAmount0, token0Decimals)}`, "info");
                log(`  ${actualToken1}: ${ethers.formatUnits(useAmount1, token1Decimals)}`, "info");
                
                const success = await addLiquidity(
                    provider, 
                    wallet, 
                    actualToken0, 
                    actualToken1, 
                    poolAddress, 
                    useAmount0, 
                    useAmount1
                );
                
                if (success) {
                    successCount++;
                    log(`Vòng cung cấp thanh khoản ${i + 1} hoàn tất thành công!`, "success");
                } else {
                    log(`Không thể cung cấp thanh khoản ở vòng ${i + 1}`, "error");
                    amount0PerLP = amount0PerLP * 8n / 10n; 
                    amount1PerLP = amount1PerLP * 8n / 10n;
                }
                
                if (i < lpCount - 1) {
                    log("Waiting 3 giây trước khi thực hiện cung cấp thanh khoản tiếp theo...", "info");
                    await delay(3000);
                }
            } catch (error) {
                log(`Lỗi ở vòng cung cấp thanh khoản ${i + 1}: ${error.message}`, "error");
                await delay(4000);
            }
        }
        
        log(`Completed ${successCount}/${lpCount} lần cung cấp thanh khoản`, "custom");
        return successCount > 0;
    } catch (error) {
        log(`Lỗi khi thực hiện nhiều lần cung cấp thanh khoản: ${error.message}`, "error");
        return false;
    }
}

async function printBalances(provider, wallet) {
    try {
        const phrsBalance = await provider.getBalance(wallet.address);
        const usdcBalance = await getTokenBalance(USDC_ADDRESS, wallet.address, provider);
        const usdtBalance = await getTokenBalance(USDT_ADDRESS, wallet.address, provider);
        const usdcDecimals = await getTokenDecimals(USDC_ADDRESS, provider);
        const usdtDecimals = await getTokenDecimals(USDT_ADDRESS, provider);
        log(`Balance hiện tại của ví ${wallet.address}:`, "info");
        log(`  PHRS: ${ethers.formatEther(phrsBalance)} PHRS`, "info");
        log(`  USDC: ${ethers.formatUnits(usdcBalance, usdcDecimals)}`, "info");
        log(`  USDT: ${ethers.formatUnits(usdtBalance, usdtDecimals)}`, "info");
    } catch (error) {
        log(`Lỗi khi in số dư: ${error.message}`, "error");
    }
}

async function main() {
console.log("Ram the Airdrop Hunter 🚀".cyan);
    await new Promise(resolve => setTimeout(resolve, 3000));
    const inviteCode = 'ejvfRPamMvwbHcqx';
    try {
        log('Airdrop farming...', 'custom');
        const { privateKeys, proxies, userAgents } = await readInputFiles();
        
        if (privateKeys.length === 0) {
            log('Not found private key nào trong wallet.txt', 'error');
            return;
        }
        // Proxy check removed
        if (userAgents.length === 0) {
            log('Not found User-Agent nào trong agent.txt', 'error');
            return;
        }
        
        if (privateKeys.length !== proxies.length) {
            log(`Error: Count mismatch private key (${privateKeys.length}) không bằng số lượng proxy (${proxies.length})`, 'error');
            log('Please ensure mỗi ví có một proxy riêng biệt!', 'error');
            return;
        }
        
        const uniqueProxies = new Set(proxies);
        if (uniqueProxies.size !== proxies.length) {
            log(`Lỗi: Duplicate proxies detected trong file proxy.txt`, 'error');
            log(`Số lượng proxy độc nhất: ${uniqueProxies.size}, tổng số proxy: ${proxies.length}`, 'error');
            log('Please ensure mỗi proxy là duy nhất để tránh bị phát hiện!', 'error');
            return;
        }
        
        log(`Đọc được ${privateKeys.length} ví, ${proxies.length} proxy, và ${userAgents.length} User-Agent`, 'success');
        const walletData = await getWalletsAndSignatures(privateKeys);
        
        const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl, {
            chainId: networkConfig.chainId,
            name: networkConfig.name,
        });
        log("Connecting to network...", "info");
        const network = await provider.getNetwork();
        log(`Connected to network: ${network.name} (${network.chainId})`, "success");
        if (Number(network.chainId) !== networkConfig.chainId) {
            throw new Error(`Kết nối đến sai chuỗi: ${network.chainId}`);
        }
        
        log("Checking pool info WPHRS/USDC...", "info");
        await checkPool(provider, USDC_POOL_ADDRESS, WPHRS_ADDRESS, USDC_ADDRESS);
        log("Kiểm tra pool WPHRS/USDT...", "info");
        await checkPool(provider, USDT_POOL_ADDRESS, WPHRS_ADDRESS, USDT_ADDRESS);
        
        let swapSuccessCount = 0;
        let finalSwapSuccessCount = 0;
        let lpSuccessCount = 0;
        
        for (let i = 0; i < walletData.length; i++) {
            const { address, signature, privateKey } = walletData[i];
            const proxy = proxies[i] || '';
            const userAgent = i < userAgents.length ? userAgents[i] : userAgents[i % userAgents.length];
            log(`\n${'='.repeat(60)}`, 'custom');
            log(`Processing wallet ${i + 1}/${walletData.length}: ${address}`, 'custom');
            log(`Using proxy: ${proxy}`, 'info');
            log(`Using User-Agent: ${userAgent}`, 'info');
            
            try {
                const proxyIP = await checkProxyIP(proxy);
                log(`Using proxy IP: ${proxyIP}`, 'info');
                const loginResponse = await login(address, signature, inviteCode, proxy, userAgent);
                log(`Login successful`, 'success');
                const jwt = loginResponse.data.jwt;
                const profileResponse = await getUserProfile(address, jwt, proxy, userAgent);
                log(`Total Points: ${profileResponse.data.user_info.TotalPoints}`, 'info');
                log(`InviteCode: ${profileResponse.data.user_info.InviteCode}`, 'info');
                const statusResponse = await getSignStatus(address, jwt, proxy, userAgent);
                if (statusResponse.data.status === '1111222') {
                    log(`Đang thực hiện điểm danh hàng ngày cho ${address}...`, 'warning');
                    const signInResponse = await performSignIn(address, jwt, proxy, userAgent);
                    if (signInResponse.code === 0) {
                        log(`Daily sign-in thành công!`, 'success');
                    } else {
                        log(`Điểm danh thất bại: ${signInResponse.msg}`, 'error');
                    }
                } else if (statusResponse.data.status === '1111022') {
                    log(`Already signed in today!`, 'warning');
                } else {
                    log(`${statusResponse.data.status}`, 'warning');
                }
                log('PHRS Faucet...', 'info');
                const faucetStatusResponse = await checkFaucetStatus(address, jwt, proxy, userAgent);
                if (faucetStatusResponse.data.is_able_to_faucet === true) {
                    const faucetResponse = await performDailyFaucet(address, jwt, proxy, userAgent);
                    if (faucetResponse.code === 0) {
                        log(`Claim successful!`, 'success');
                    } else {
                        log(`Claim failed: ${faucetResponse.msg}`, 'error');
                    }
                } else {
                    log(`PHRS already claimed today.`, 'warning');
                }
            } catch (error) {
                log(`API error cho ví ${address}: ${error.message}`, 'error');
                log('Continuing with on-chain steps...', 'warning');
            }
            
            try {
                const wallet = new ethers.Wallet(privateKey, provider);
                log(`Starting on-chain execution cho ví ${wallet.address}`, 'custom');
                await printBalances(provider, wallet);
                const swapSuccess = await performMultipleSwaps(provider, wallet, SWAP_ROUNDS);
                if (swapSuccess) {
                    swapSuccessCount++;
                    await printBalances(provider, wallet);
                    const finalSwapSuccess = await performFinalSwaps(provider, wallet);
                    if (finalSwapSuccess) {
                        finalSwapSuccessCount++;
                        await printBalances(provider, wallet);
                        log("STEP: Adding liquidity", "custom");
                        log("Adding liquidity cho WPHRS/USDC (10 lần)", "custom");
                        const usdcLPSuccess = await performMultipleLPs(
                            provider,
                            wallet,
                            WPHRS_ADDRESS,
                            USDC_ADDRESS,
                            USDC_POOL_ADDRESS,
                            LP_ROUNDS
                        );
                        if (usdcLPSuccess) {
                            lpSuccessCount++;
                        }
                    }
                }
                log("Final wallet status:", "custom");
                await printBalances(provider, wallet);
            } catch (error) {
                log(`Lỗi xử lý on-chain cho ví ${address}: ${error.message}`, 'error');
            }
            
            if (i < walletData.length - 1) {
                log("Waiting 5 giây trước khi xử lý ví tiếp theo...", "info");
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        
        log(`==== All wallets processed ====`, "custom");
        log(`Swap: Success: ${swapSuccessCount}/${walletData.length}`, "info");
        log(`Swap để cung cấp thanh khoản: Success: ${finalSwapSuccessCount}/${walletData.length}`, "info");
        log(`Adding liquidity: Success: ${lpSuccessCount}/${walletData.length}`, "info");
        log('Done :)))', 'success');
    } catch (error) {
        log(`Main function error: ${error}`, 'error');
    }
}

main().catch(error => log(`Unexpected error: ${error}`, "error"));