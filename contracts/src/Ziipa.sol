// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Non-upgradeable, permissionless self-minting. No platform custody or admin key.
contract ZiipaCollectibles is ERC721Enumerable, ERC721URIStorage, ERC2981, ReentrancyGuard {
    uint256 private nextId = 1;
    event Created(uint256 indexed tokenId, address indexed creator, string uri);
    constructor() ERC721("Ziipa Studio", "ZIIPA") {}
    function mint(string calldata uri, uint96 royaltyBps) external nonReentrant returns (uint256 id) {
        require(bytes(uri).length > 7 && bytes(uri).length <= 200, "Invalid URI");
        require(royaltyBps <= 1000, "Royalty exceeds 10 percent");
        id = nextId++;
        _safeMint(msg.sender, id);
        _setTokenURI(id, uri);
        _setTokenRoyalty(id, msg.sender, royaltyBps);
        emit Created(id, msg.sender, uri);
    }
    function tokenURI(uint256 id) public view override(ERC721, ERC721URIStorage) returns (string memory) { return super.tokenURI(id); }
    function supportsInterface(bytes4 id) public view override(ERC721Enumerable, ERC721URIStorage, ERC2981) returns (bool) { return super.supportsInterface(id); }
    function _update(address to, uint256 id, address auth) internal override(ERC721, ERC721Enumerable) returns (address) { return super._update(to, id, auth); }
    function _increaseBalance(address account, uint128 amount) internal override(ERC721, ERC721Enumerable) { super._increaseBalance(account, amount); }
}

/// @notice Fixed supply is issued once to the creator; no later minting or admin privileges.
contract ZiipaCreatorToken is ERC20 {
    string public metadataURI;
    constructor(string memory name_, string memory symbol_, uint256 supply, string memory uri, address creator) ERC20(name_, symbol_) {
        metadataURI = uri;
        _mint(creator, supply);
    }
}

contract ZiipaTokenFactory {
    mapping(address => bool) public isCreatorToken;
    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 supply, string uri);
    function createToken(string calldata name, string calldata symbol, uint256 supply, string calldata uri) external returns (address token) {
        require(bytes(name).length > 0 && bytes(name).length <= 80, "Invalid name");
        require(bytes(symbol).length > 0 && bytes(symbol).length <= 10, "Invalid symbol");
        require(supply > 0 && supply <= 1_000_000_000 ether, "Invalid supply");
        require(bytes(uri).length > 7 && bytes(uri).length <= 200, "Invalid URI");
        token = address(new ZiipaCreatorToken(name, symbol, supply, uri, msg.sender));
        isCreatorToken[token] = true;
        emit TokenCreated(token, msg.sender, name, symbol, supply, uri);
    }
}

/// @notice Atomic native-currency tips with an optional, explicitly chosen curator split.
contract ZiipaTips is ReentrancyGuard {
    event Tipped(address indexed sender, address indexed creator, address indexed curator, uint256 amount, uint256 curatorAmount);
    function tip(address payable creator, address payable curator, uint16 curatorBps) external payable nonReentrant {
        require(creator != address(0) && msg.value > 0, "Invalid tip");
        require(curatorBps <= 5000 && (curatorBps == 0 || curator != address(0)), "Invalid split");
        uint256 split = msg.value * curatorBps / 10000;
        (bool ok,) = creator.call{value: msg.value - split}("");
        require(ok, "Creator payment failed");
        if (split > 0) { (ok,) = curator.call{value: split}(""); require(ok, "Curator payment failed"); }
        emit Tipped(msg.sender, creator, curator, msg.value, split);
    }
}
