module robomata_overflow::facility {
    use std::string::String;
    use sui::address;
    use sui::clock::{Self, Clock};

    const E_NOT_AUTHORIZED_OPERATOR: u64 = 1;
    const E_INVALID_SEAL_IDENTITY: u64 = 2;

    public struct Facility has key, store {
        id: sui::object::UID,
        operator: address,
        update_authority: address,
        gross_receivables_cents: u64,
        eligible_receivables_cents: u64,
        advance_rate_bps: u64,
        available_cents: u64,
        evidence_root: vector<u8>,
        updated_ms: u64,
    }

    public struct FacilityCreated has copy, drop {
        facility_id: address,
        operator: address,
        available_cents: u64,
    }

    public struct BorrowingBaseUpdated has copy, drop {
        facility_id: address,
        eligible_receivables_cents: u64,
        available_cents: u64,
    }

    public struct EvidenceCommitted has copy, drop {
        facility_id: address,
        evidence_kind: String,
        evidence_digest: vector<u8>,
    }

    public struct SealPolicyApproved has copy, drop {
        facility_id: address,
        operator: address,
    }

    entry fun create_facility(
        operator: address,
        gross_receivables_cents: u64,
        eligible_receivables_cents: u64,
        advance_rate_bps: u64,
        available_cents: u64,
        evidence_root: vector<u8>,
        clock: &Clock,
        ctx: &mut sui::tx_context::TxContext,
    ) {
        let id = sui::object::new(ctx);
        let facility_id = sui::object::uid_to_address(&id);
        let facility = Facility {
            id,
            operator,
            update_authority: tx_context::sender(ctx),
            gross_receivables_cents,
            eligible_receivables_cents,
            advance_rate_bps,
            available_cents,
            evidence_root,
            updated_ms: clock::timestamp_ms(clock),
        };

        sui::event::emit(FacilityCreated {
            facility_id,
            operator,
            available_cents,
        });

        sui::transfer::share_object(facility);
    }

    entry fun update_borrowing_base(
        facility: &mut Facility,
        gross_receivables_cents: u64,
        eligible_receivables_cents: u64,
        advance_rate_bps: u64,
        available_cents: u64,
        evidence_root: vector<u8>,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_update_authority(facility, tx_context::sender(ctx));
        facility.gross_receivables_cents = gross_receivables_cents;
        facility.eligible_receivables_cents = eligible_receivables_cents;
        facility.advance_rate_bps = advance_rate_bps;
        facility.available_cents = available_cents;
        facility.evidence_root = evidence_root;
        facility.updated_ms = clock::timestamp_ms(clock);

        sui::event::emit(BorrowingBaseUpdated {
            facility_id: sui::object::uid_to_address(&facility.id),
            eligible_receivables_cents,
            available_cents,
        });
    }

    entry fun commit_evidence(
        facility: &Facility,
        evidence_kind: String,
        evidence_digest: vector<u8>,
        ctx: &TxContext,
    ) {
        assert_operator(facility, tx_context::sender(ctx));
        sui::event::emit(EvidenceCommitted {
            facility_id: sui::object::uid_to_address(&facility.id),
            evidence_kind,
            evidence_digest,
        });
    }

    public fun seal_approve(id: vector<u8>, facility: &Facility, ctx: &mut TxContext) {
        assert_operator(facility, tx_context::sender(ctx));
        let facility_id = sui::object::uid_to_address(&facility.id);
        assert!(id == address::to_bytes(facility_id), E_INVALID_SEAL_IDENTITY);

        sui::event::emit(SealPolicyApproved {
            facility_id,
            operator: tx_context::sender(ctx),
        });
    }

    public fun available_cents(facility: &Facility): u64 {
        facility.available_cents
    }

    fun assert_operator(facility: &Facility, caller: address) {
        assert_operator_address(facility.operator, caller);
    }

    fun assert_update_authority(facility: &Facility, caller: address) {
        assert!(facility.update_authority == caller, E_NOT_AUTHORIZED_OPERATOR);
    }

    fun assert_operator_address(operator: address, caller: address) {
        assert!(operator == caller, E_NOT_AUTHORIZED_OPERATOR);
    }

    #[test_only]
    fun assert_update_authority_address(update_authority: address, caller: address) {
        assert!(update_authority == caller, E_NOT_AUTHORIZED_OPERATOR);
    }

    #[test]
    fun authorized_operator_passes() {
        assert_operator_address(@0xA, @0xA);
    }

    #[test]
    fun authorized_update_authority_passes() {
        assert_update_authority_address(@0xB, @0xB);
    }

    #[test, expected_failure(abort_code = E_NOT_AUTHORIZED_OPERATOR)]
    fun operator_cannot_update_borrowing_base() {
        assert_update_authority_address(@0xB, @0xA);
    }

    #[test, expected_failure(abort_code = E_NOT_AUTHORIZED_OPERATOR)]
    fun unauthorized_update_authority_fails() {
        assert_update_authority_address(@0xB, @0xC);
    }

    #[test, expected_failure(abort_code = E_NOT_AUTHORIZED_OPERATOR)]
    fun unauthorized_operator_fails() {
        assert_operator_address(@0xA, @0xB);
    }

    #[test]
    fun seal_identity_matches_facility_id() {
        assert!(address::to_bytes(@0xA) == address::to_bytes(@0xA), E_INVALID_SEAL_IDENTITY);
    }

    #[test, expected_failure(abort_code = E_INVALID_SEAL_IDENTITY)]
    fun seal_identity_mismatch_fails() {
        assert!(address::to_bytes(@0xA) == address::to_bytes(@0xB), E_INVALID_SEAL_IDENTITY);
    }
}
