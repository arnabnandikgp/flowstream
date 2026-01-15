use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};

declare_id!("25TKhNPvgaQbD1sqLwt45F4532Vgi4qBqvBEd4Gk4pdE");

pub const SESSION_SEED: &[u8] = b"session";

#[ephemeral]
#[program]
pub mod flowstream {
    use super::*;

    pub fn initialize_session(
        ctx: Context<InitializeSession>,
        service_id: Pubkey,
        unit: u8,
        decimals: u8,
    ) -> Result<()> {
        let session = &mut ctx.accounts.session;
        session.owner = ctx.accounts.owner.key();
        session.service_id = service_id;
        session.unit = unit;
        session.decimals = decimals;
        session.total_usage = 0;
        session.last_event_ts = Clock::get()?.unix_timestamp;
        session.status = SessionStatus::Active as u8;
        session.bump = ctx.bumps.session;
        Ok(())
    }

    pub fn record_usage(ctx: Context<RecordUsage>, amount: u64) -> Result<()> {
        let session = &mut ctx.accounts.session;
        require!(
            session.status == SessionStatus::Active as u8,
            FlowstreamError::SessionClosed
        );
        require_keys_eq!(session.owner, ctx.accounts.owner.key(), FlowstreamError::Unauthorized);
        session.total_usage = session
            .total_usage
            .checked_add(amount)
            .ok_or(FlowstreamError::UsageOverflow)?;
        session.last_event_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn close_session(ctx: Context<CloseSession>) -> Result<()> {
        let session = &mut ctx.accounts.session;
        require_keys_eq!(session.owner, ctx.accounts.owner.key(), FlowstreamError::Unauthorized);
        session.status = SessionStatus::Closed as u8;
        session.last_event_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn delegate(ctx: Context<DelegateSession>, owner: Pubkey, service_id: Pubkey) -> Result<()> {
        require_keys_eq!(ctx.accounts.payer.key(), owner, FlowstreamError::Unauthorized);
        let (expected, _) = Pubkey::find_program_address(
            &[SESSION_SEED, owner.as_ref(), service_id.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(ctx.accounts.pda.key(), expected, FlowstreamError::InvalidSession);
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[SESSION_SEED, owner.as_ref(), service_id.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    pub fn commit(ctx: Context<CommitSession>) -> Result<()> {
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.session.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    pub fn commit_and_undelegate(ctx: Context<CommitSession>) -> Result<()> {
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.session.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(service_id: Pubkey)]
pub struct InitializeSession<'info> {
    #[account(
        init,
        payer = owner,
        space = UsageSession::SIZE,
        seeds = [SESSION_SEED, owner.key().as_ref(), service_id.as_ref()],
        bump
    )]
    pub session: Account<'info, UsageSession>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordUsage<'info> {
    #[account(mut, has_one = owner)]
    pub session: Account<'info, UsageSession>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseSession<'info> {
    #[account(mut, has_one = owner)]
    pub session: Account<'info, UsageSession>,
    pub owner: Signer<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateSession<'info> {
    pub payer: Signer<'info>,
    /// CHECK: PDA delegated to the delegation program
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub session: Account<'info, UsageSession>,
}

#[account]
pub struct UsageSession {
    pub owner: Pubkey,
    pub service_id: Pubkey,
    pub unit: u8,
    pub decimals: u8,
    pub status: u8,
    pub bump: u8,
    pub total_usage: u64,
    pub last_event_ts: i64,
}

impl UsageSession {
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 1 + 1 + 1 + 8 + 8;
}

#[repr(u8)]
pub enum SessionStatus {
    Active = 1,
    Closed = 2,
}

#[error_code]
pub enum FlowstreamError {
    #[msg("Session is closed")]
    SessionClosed,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Usage overflow")]
    UsageOverflow,
    #[msg("Invalid session account")]
    InvalidSession,
}
