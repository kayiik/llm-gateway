package api

import (
	"encoding/json"
	"math"
	"math/big"
	"strconv"
	"strings"
)

// nativeUsageCount keeps invalid provider counts distinct from an absent or
// valid zero count before the accounting boundary validates their sum.
func nativeUsageCount(value any) (int, bool) {
	switch n := value.(type) {
	case nil:
		return 0, true
	case int:
		return n, n >= 0
	case int64:
		return int(n), n >= 0 && uint64(n) <= uint64(math.MaxInt)
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n >= math.Ldexp(1, strconv.IntSize-1) || math.Trunc(n) != n {
			return 0, false
		}
		return int(n), true
	case json.Number:
		if integer, err := n.Int64(); err == nil {
			return nativeUsageCount(integer)
		}
		approximate, err := n.Float64()
		if err != nil || math.IsNaN(approximate) || math.IsInf(approximate, 0) || approximate < 0 || approximate > math.Ldexp(1, strconv.IntSize-1) {
			return 0, false
		}
		if approximate == 0 {
			coefficient, _, _ := strings.Cut(strings.ToLower(string(n)), "e")
			return 0, strings.Trim(coefficient, "-0.") == ""
		}
		// Bound decimal work before exact parsing; enormous exponents must not
		// allocate enormous integers merely to reject a non-integral count.
		if approximate < 1 || len(n) > 128 {
			return 0, false
		}
		exact, ok := new(big.Rat).SetString(string(n))
		if !ok || !exact.IsInt() || !exact.Num().IsInt64() {
			return 0, false
		}
		return nativeUsageCount(exact.Num().Int64())
	}
	return 0, false
}
