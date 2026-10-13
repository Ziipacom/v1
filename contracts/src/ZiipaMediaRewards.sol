// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Creator-funded ERC20 media rewards. No operator custody, minting, or admin key.
/// @dev Only standard fixed-balance tokens are supported. Published reservations never expire
///      and cannot be replaced or reclaimed, even by their creator. Testnet demo only in Ziipa.
contract ZiipaMediaRewards is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_DEPOSIT = 1_000_000_000 ether;

    struct Batch {
        address owner;
        address token;
        bytes32 root;
        uint256 totalAmount;
        uint256 remainingAmount;
    }

    // Unreserved and permanently reserved balances are separate for every creator/token pool.
    mapping(address owner => mapping(address token => uint256)) public poolCredits;
    mapping(address owner => mapping(address token => uint256)) public reservedCredits;
    mapping(address token => uint256) public totalAccounted;
    mapping(bytes32 batchId => Batch) public batches;
    mapping(bytes32 batchId => mapping(address recipient => bool)) public claimed;

    error InvalidToken();
    error InvalidAmount();
    error InvalidBatch();
    error BatchAlreadyPublished();
    error InsufficientAvailable();
    error InsolventToken();
    error UnsupportedTokenTransfer();
    error AlreadyClaimed();
    error InvalidProof();
    error InsufficientReservation();

    event Deposited(address indexed owner, address indexed token, uint256 amount);
    event BatchPublished(bytes32 indexed batchId, address indexed owner, address indexed token, bytes32 root, uint256 totalAmount);
    event Claimed(bytes32 indexed batchId, address indexed recipient, uint256 amount);
    event Withdrawn(address indexed owner, address indexed token, uint256 amount);

    /// @notice Deposit approved tokens into the caller's pool. A transfer cannot credit another creator.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (token == address(0) || token.code.length == 0) revert InvalidToken();
        if (amount == 0 || amount > MAX_DEPOSIT) revert InvalidAmount();
        IERC20 asset = IERC20(token);
        uint256 beforeBalance = asset.balanceOf(address(this));
        if (beforeBalance < totalAccounted[token]) revert InsolventToken();
        uint256 ownerBefore = asset.balanceOf(msg.sender);
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBalance = asset.balanceOf(address(this));
        uint256 ownerAfter = asset.balanceOf(msg.sender);
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount
            || ownerAfter > ownerBefore || ownerBefore - ownerAfter != amount) revert UnsupportedTokenTransfer();
        poolCredits[msg.sender][token] += amount;
        totalAccounted[token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Reserve an immutable batch funded only from the caller's unreserved pool.
    /// @dev A mistaken root or unclaimable allocation remains reserved forever. Review before signing.
    function publishBatch(bytes32 batchId, address token, bytes32 root, uint256 totalAmount) external nonReentrant {
        if (batchId == bytes32(0) || root == bytes32(0)) revert InvalidBatch();
        // The first 20 bytes are the publishing wallet, leaving 12 bytes for a unique salt.
        // Another creator cannot front-run an observed batch ID with their own funded pool.
        if (bytes20(batchId) != bytes20(msg.sender)) revert InvalidBatch();
        if (batches[batchId].owner != address(0)) revert BatchAlreadyPublished();
        if (totalAmount == 0 || totalAmount > MAX_DEPOSIT) revert InvalidAmount();
        if (poolCredits[msg.sender][token] < totalAmount) revert InsufficientAvailable();
        if (IERC20(token).balanceOf(address(this)) < totalAccounted[token]) revert InsolventToken();
        poolCredits[msg.sender][token] -= totalAmount;
        reservedCredits[msg.sender][token] += totalAmount;
        batches[batchId] = Batch(msg.sender, token, root, totalAmount, totalAmount);
        emit BatchPublished(batchId, msg.sender, token, root, totalAmount);
    }

    /// @notice Claim one's own allocation; third parties cannot redirect a proof's recipient.
    function claim(bytes32 batchId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Batch storage batch = batches[batchId];
        if (batch.owner == address(0)) revert InvalidBatch();
        if (amount == 0) revert InvalidAmount();
        if (claimed[batchId][msg.sender]) revert AlreadyClaimed();
        if (!MerkleProof.verifyCalldata(proof, batch.root, leafHash(batchId, msg.sender, amount))) revert InvalidProof();
        if (amount > batch.remainingAmount) revert InsufficientReservation();

        claimed[batchId][msg.sender] = true;
        batch.remainingAmount -= amount;
        reservedCredits[batch.owner][batch.token] -= amount;
        totalAccounted[batch.token] -= amount;
        _transferExact(batch.token, msg.sender, amount);
        emit Claimed(batchId, msg.sender, amount);
    }

    /// @notice Withdraw only the caller's unreserved balance, only to the caller.
    function withdraw(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (poolCredits[msg.sender][token] < amount) revert InsufficientAvailable();
        poolCredits[msg.sender][token] -= amount;
        totalAccounted[token] -= amount;
        _transferExact(token, msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    /// @notice OpenZeppelin StandardMerkleTree-compatible leaf, including the batch domain.
    function leafHash(bytes32 batchId, address recipient, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(batchId, recipient, amount))));
    }

    function _transferExact(address token, address recipient, uint256 amount) private {
        IERC20 asset = IERC20(token);
        uint256 beforeBalance = asset.balanceOf(address(this));
        // Accounting was reduced before this helper, so include the outgoing allocation here.
        if (beforeBalance < totalAccounted[token] + amount) revert InsolventToken();
        uint256 recipientBefore = asset.balanceOf(recipient);
        asset.safeTransfer(recipient, amount);
        uint256 afterBalance = asset.balanceOf(address(this));
        uint256 recipientAfter = asset.balanceOf(recipient);
        if (afterBalance > beforeBalance || beforeBalance - afterBalance != amount
            || recipientAfter < recipientBefore || recipientAfter - recipientBefore != amount) {
            revert UnsupportedTokenTransfer();
        }
    }
}
