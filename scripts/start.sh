#!/bin/bash
# Stock Picking Contest - Startup Script

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo "========================================"
echo "   Stock Picking Contest"
echo "========================================"
echo ""

# Navigate to project root (parent of scripts/)
cd "$(dirname "$0")/.."

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is required but not installed.${NC}"
    exit 1
fi

echo -e "Node.js $(node -v)"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Dependencies installed successfully${NC}"
    else
        echo -e "${RED}Failed to install dependencies${NC}"
        exit 1
    fi
fi

echo ""
echo -e "${GREEN}Starting server...${NC}"
echo ""
echo "Access the app at:"
echo "  http://localhost:3001"
echo ""
echo "Press Ctrl+C to stop the server"
echo "Server will auto-restart on crash."
echo "========================================"
echo ""

# Run the server with auto-restart on crash
trap 'echo -e "\n${YELLOW}Shutting down...${NC}"; exit 0' INT TERM

while true; do
    npx next dev --port 3001
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 0 ]; then
        echo -e "${GREEN}Server stopped cleanly.${NC}"
        break
    fi
    echo ""
    echo -e "${RED}Server exited with code $EXIT_CODE. Restarting in 5 seconds...${NC}"
    echo -e "${YELLOW}(Press Ctrl+C to stop)${NC}"
    sleep 5
    echo -e "${GREEN}Restarting server...${NC}"
    echo ""
done
