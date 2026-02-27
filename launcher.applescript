tell application "Terminal"
	activate
	do script "cd '/Users/Yitzi/Desktop/stock-contest' && ./scripts/start.sh"
end tell

-- Poll until the server is ready (every 2s, up to 30s)
repeat 15 times
	try
		do shell script "curl -s -o /dev/null -w '%{http_code}' http://localhost:3001 | grep -q 200"
		exit repeat
	end try
	delay 2
end repeat

-- Open in default browser (no Automation permission needed)
do shell script "open 'http://localhost:3001'"
