package relay

import "testing"

func TestOwnershipChangeRequired(t *testing.T) {
	tests := []struct {
		name         string
		existingUID  uint32
		existingGID  uint32
		effectiveUID int
		effectiveGID int
		want         bool
	}{
		{name: "same owner", existingUID: 1001, existingGID: 1002, effectiveUID: 1001, effectiveGID: 1002, want: false},
		{name: "different user", existingUID: 1001, existingGID: 1002, effectiveUID: 0, effectiveGID: 1002, want: true},
		{name: "different group", existingUID: 1001, existingGID: 1002, effectiveUID: 1001, effectiveGID: 0, want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ownershipChangeRequired(
				test.existingUID,
				test.existingGID,
				test.effectiveUID,
				test.effectiveGID,
			); got != test.want {
				t.Fatalf("ownershipChangeRequired() = %v, want %v", got, test.want)
			}
		})
	}
}
