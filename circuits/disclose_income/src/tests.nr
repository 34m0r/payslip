use crate::{main, N};
use stellar_confidential_lib::{ecdh, encrypt_amount, H, scalar_mul, vk_from_sk};

// Fixture: three monthly salaries paid by an employer to one employee.
// Amounts in base units would be x10^7; small integers keep tests readable.
global SK: Field = 0xdead;
global ADDR_F: Field = 0xbeef;
global R_E: [Field; 3] = [0x1111, 0x2222, 0x3333]; // employer's ephemeral scalars
global SIGMA: [Field; 3] = [0xa1, 0xa2, 0xa3];
global SALARIES: [Field; 3] = [1800, 1900, 2000]; // total 5700
global R_R: Field = 0xfeed; // landlord's disclosure key
global NU: Field = 0x4242;

struct Fixture {
    pvk_x: Field,
    pvk_y: Field,
    r_e_x: [Field; N],
    r_e_y: [Field; N],
    v_tilde: [Field; N],
    p_r_x: Field,
    p_r_y: Field,
}

fn fixture() -> Fixture {
    let vk = vk_from_sk(SK, ADDR_F);
    let pvk = scalar_mul(vk, H);
    let mut r_e_x = [0; N];
    let mut r_e_y = [0; N];
    let mut v_tilde = [0; N];
    for i in 0..N {
        let p = scalar_mul(R_E[i], H);
        r_e_x[i] = p.x;
        r_e_y[i] = p.y;
        // sender-side encryption, as the transfer circuit does
        v_tilde[i] = encrypt_amount(SALARIES[i], ecdh(R_E[i], pvk), SIGMA[i]);
    }
    let p_r = scalar_mul(R_R, H);
    Fixture { pvk_x: pvk.x, pvk_y: pvk.y, r_e_x, r_e_y, v_tilde, p_r_x: p_r.x, p_r_y: p_r.y }
}

fn run(f: Fixture, sk: Field, v: [Field; N], sigma: [Field; N], threshold: Field, nu: Field) {
    main(sk, v, ADDR_F, f.pvk_x, f.pvk_y, f.r_e_x, f.r_e_y, sigma, f.v_tilde, threshold, f.p_r_x, f.p_r_y, nu);
}

#[test]
fn proves_income_above_threshold() {
    run(fixture(), SK, SALARIES, SIGMA, 5400, NU);
}

#[test]
fn proves_income_exactly_at_threshold() {
    run(fixture(), SK, SALARIES, SIGMA, 5700, NU);
}

#[test(should_fail)]
fn rejects_income_below_threshold() {
    run(fixture(), SK, SALARIES, SIGMA, 5701, NU);
}

#[test(should_fail)]
fn rejects_inflated_salary() {
    run(fixture(), SK, [1800, 1900, 9000], SIGMA, 5400, NU);
}

#[test(should_fail)]
fn rejects_wrong_sk() {
    run(fixture(), 0xbad, SALARIES, SIGMA, 5400, NU);
}

#[test(should_fail)]
fn rejects_wrong_sigma() {
    run(fixture(), SK, SALARIES, [0xa1, 0xa2, 0xff], 5400, NU);
}

#[test(should_fail)]
fn rejects_same_event_counted_twice() {
    // Re-submitting event 0 three times: identical sigma is refused (I7).
    let f = fixture();
    let dup = Fixture {
        pvk_x: f.pvk_x, pvk_y: f.pvk_y,
        r_e_x: [f.r_e_x[0], f.r_e_x[0], f.r_e_x[0]],
        r_e_y: [f.r_e_y[0], f.r_e_y[0], f.r_e_y[0]],
        v_tilde: [f.v_tilde[0], f.v_tilde[0], f.v_tilde[0]],
        p_r_x: f.p_r_x, p_r_y: f.p_r_y,
    };
    run(dup, SK, [1800, 1800, 1800], [0xa1, 0xa1, 0xa1], 5400, NU);
}

#[test(should_fail)]
fn rejects_zero_nonce() {
    run(fixture(), SK, SALARIES, SIGMA, 5400, 0);
}

#[test(should_fail)]
fn rejects_negative_threshold_trick() {
    // A "negative" threshold (p - 1) must not make any total pass.
    run(fixture(), SK, SALARIES, SIGMA, -1, NU);
}

// Prints a valid witness for Prover.toml (nargo test print_fixture --show-output).
#[test]
fn print_fixture() {
    let f = fixture();
    let (sk, addr_f, pvk_x, pvk_y, p_r_x, p_r_y, nu) = (SK, ADDR_F, f.pvk_x, f.pvk_y, f.p_r_x, f.p_r_y, NU);
    println(f"sk={sk}");
    println(f"addr_f={addr_f}");
    println(f"pvk_x={pvk_x}");
    println(f"pvk_y={pvk_y}");
    for i in 0..N {
        let x = f.r_e_x[i]; let y = f.r_e_y[i]; let t = f.v_tilde[i]; let s = SIGMA[i]; let v = SALARIES[i];
        println(f"r_e_x.{i}={x}");
        println(f"r_e_y.{i}={y}");
        println(f"v_tilde.{i}={t}");
        println(f"sigma.{i}={s}");
        println(f"v.{i}={v}");
    }
    println(f"p_r_x={p_r_x}");
    println(f"p_r_y={p_r_y}");
    println(f"nu={nu}");
}
