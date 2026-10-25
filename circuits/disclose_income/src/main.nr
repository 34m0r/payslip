use std::embedded_curve_ops::EmbeddedCurvePoint;
use stellar_confidential_lib::{assert_on_curve_non_identity, ecdh, encrypt_amount, H, scalar_mul, vk_from_sk};

mod tests;

// D-income - aggregate threshold disclosure for Payslip.
//
// Built on the D-recipient circuit of stellar-confidential-token-sdk
// (docs/selective-disclosure/circuits/d-recipient.md) and the "finite set of
// events + threshold" disclosure type of OpenZeppelin's selective-disclosure
// spec. The holder of a confidential account proves, to one designated
// verifier (P_R, nu), that N on-chain confidential transfers it RECEIVED sum
// to AT LEAST `threshold` - revealing no individual amount and not the total.
//
// Verified OFF-chain (bb.js). The verifier MUST source every public input
// except (p_r, nu, threshold - its own request) from on-chain state resolved
// via the N event references, and check off-chain that every event is a
// Transfer from the employer to `to`, at distinct (tx, index), in the claimed
// period.
//
// Constraints
//   I1  vk = Poseidon2(delta_vk, sk, addr_f)             (D1)
//   I2  PVK = vk * H  == account viewing key            (D2)
//   for i in 0..N:
//   I3    R_e[i] on curve, non-identity
//   I4    s_i = ECDH(vk, R_e[i])                          (D3)
//   I5    v_tilde[i] == encrypt(v_i, s_i, sigma[i])       (D4: correct decryption)
//   I6    v_i in [0, 2^127)                               (D5)
//   I7  sigma[i] pairwise distinct                        (no event counted twice)
//   I8  threshold in [0, 2^127)
//   I9  sum(v_i) - threshold in [0, 2^130)                => sum >= threshold
//   I10 P_R on curve non-identity, nu != 0                (verifier binding)
//
// Public inputs (4N + 6 fields): addr_f, pvk_x, pvk_y,
//   r_e_x[N], r_e_y[N], sigma[N], v_tilde[N], threshold, p_r_x, p_r_y, nu
// Private witnesses: sk, v[N]

pub global N: u32 = 3;

fn main(
    sk: Field,
    v: [Field; N],
    addr_f: pub Field,
    pvk_x: pub Field,
    pvk_y: pub Field,
    r_e_x: pub [Field; N],
    r_e_y: pub [Field; N],
    sigma: pub [Field; N],
    v_tilde: pub [Field; N],
    threshold: pub Field,
    p_r_x: pub Field,
    p_r_y: pub Field,
    nu: pub Field,
) {
    // I1, I2
    let vk = vk_from_sk(sk, addr_f);
    let pvk = scalar_mul(vk, H);
    assert(pvk.x == pvk_x);
    assert(pvk.y == pvk_y);

    let mut total: Field = 0;
    for i in 0..N {
        // I3
        let r_e = EmbeddedCurvePoint { x: r_e_x[i], y: r_e_y[i], is_infinite: false };
        assert_on_curve_non_identity(r_e);
        // I4, I5
        let s = ecdh(vk, r_e);
        assert(encrypt_amount(v[i], s, sigma[i]) == v_tilde[i]);
        // I6
        v[i].assert_max_bit_size::<127>();
        total += v[i];
        // I7
        for j in 0..i {
            assert(sigma[i] != sigma[j]);
        }
    }

    // I8, I9 - sum < 3*2^127 < 2^129, so a non-negative difference fits 130 bits;
    // a negative one wraps to ~2^254 and fails.
    threshold.assert_max_bit_size::<127>();
    (total - threshold).assert_max_bit_size::<130>();

    // I10
    let p_r = EmbeddedCurvePoint { x: p_r_x, y: p_r_y, is_infinite: false };
    assert_on_curve_non_identity(p_r);
    assert(nu != 0);
}
