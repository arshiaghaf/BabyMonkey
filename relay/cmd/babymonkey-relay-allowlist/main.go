package main

import (
	"log"
	"os"

	"github.com/arshiaghaf/near/relay/internal/relay"
)

const productionAllowlist = "/etc/babymonkey-relay/allowlist.json"

func main() {
	if len(os.Args) > 3 {
		log.Fatal("event=allowlist_update outcome=invalid_arguments")
	}
	if err := relay.WriteAllowlist(productionAllowlist, os.Args[1:]); err != nil {
		log.Fatal("event=allowlist_update outcome=failed")
	}
}
