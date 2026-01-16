use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};

declare_id!("B6WJ2C7RhGLQPCrXZzVqbTC2YaPiC9FAH2LE52WXDFiF");

pub const SESSION_SEED: &[u8] = b"session";
pub const ESCROW_SEED: &[u8] = b"escrow";

#[ephemeral]
#[program]
pub mod flowstream {
    use super::*;

    pub fn initialize_session(
        ctx: Context<InitializeSession>,
        service_id: Pubkey,
        unit: u8,
        decimals: u8,
        deposit_lamports: u64,
        rate_lamports_per_unit: u64,
        merchant: Pubkey,
    ) -> Result<()> {
        require!(deposit_lamports > 0, FlowstreamError::InvalidDeposit);
        require!(rate_lamports_per_unit > 0, FlowstreamError::InvalidRate);
        let session = &mut ctx.accounts.session;
        session.owner = ctx.accounts.owner.key();
        session.service_id = service_id;
        session.unit = unit;
        session.decimals = decimals;
        session.deposit_lamports = deposit_lamports;
        session.rate_lamports_per_unit = rate_lamports_per_unit;
        session.merchant = merchant;
        session.escrow_bump = ctx.bumps.escrow;
        session.total_usage = 0;
        session.settled_cost_lamports = 0;
        session.refunded_lamports = 0;
        session.last_event_ts = Clock::get()?.unix_timestamp;
        session.status = SessionStatus::Active as u8;
        session.bump = ctx.bumps.session;

        let transfer_accounts = anchor_lang::system_program::Transfer {
            from: ctx.accounts.owner.to_account_info(),
            to: ctx.accounts.escrow.to_account_info(),
        };
        let transfer_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            transfer_accounts,
        );
        anchor_lang::system_program::transfer(transfer_ctx, deposit_lamports)?;
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
        require_keys_eq!(
            ctx.accounts.session.owner,
            ctx.accounts.payer.key(),
            FlowstreamError::Unauthorized
        );
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.session.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    pub fn commit_and_undelegate(ctx: Context<CommitSession>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.session.owner,
            ctx.accounts.payer.key(),
            FlowstreamError::Unauthorized
        );
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.session.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    pub fn settle_session(ctx: Context<SettleSession>) -> Result<()> {
        let session = &mut ctx.accounts.session;
        require!(
            session.status == SessionStatus::Active as u8,
            FlowstreamError::SessionClosed
        );
        require_keys_eq!(session.owner, ctx.accounts.owner.key(), FlowstreamError::Unauthorized);
        require_keys_eq!(
            session.merchant,
            ctx.accounts.merchant.key(),
            FlowstreamError::InvalidMerchant
        );

        let cost = session
            .total_usage
            .checked_mul(session.rate_lamports_per_unit)
            .ok_or(FlowstreamError::UsageOverflow)?;
        let settled_cost = cost.min(session.deposit_lamports);
        let refund = session
            .deposit_lamports
            .checked_sub(settled_cost)
            .ok_or(FlowstreamError::RefundOverflow)?;

        let session_key = session.key();
        let escrow_seeds = &[ESCROW_SEED, session_key.as_ref(), &[session.escrow_bump]];
        let signer_seeds = &[escrow_seeds.as_ref()];

        if settled_cost > 0 {
            let transfer_accounts = anchor_lang::system_program::Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.merchant.to_account_info(),
            };
            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                transfer_accounts,
                signer_seeds,
            );
            anchor_lang::system_program::transfer(transfer_ctx, settled_cost)?;
        }

        if refund > 0 {
            let refund_accounts = anchor_lang::system_program::Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.owner.to_account_info(),
            };
            let refund_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                refund_accounts,
                signer_seeds,
            );
            anchor_lang::system_program::transfer(refund_ctx, refund)?;
        }

        session.settled_cost_lamports = settled_cost;
        session.refunded_lamports = refund;
        session.status = SessionStatus::Closed as u8;
        session.last_event_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(service_id: Pubkey)]
pub struct InitializeSession<'info> {
    #[account(
        init_if_needed,
        payer = owner,
        space = UsageSession::SIZE,
        seeds = [SESSION_SEED, owner.key().as_ref(), service_id.as_ref()],
        bump
    )]
    pub session: Account<'info, UsageSession>,
    #[account(
        init,
        payer = owner,
        space = 0,
        seeds = [ESCROW_SEED, session.key().as_ref()],
        bump,
        owner = anchor_lang::system_program::ID
    )]
    /// CHECK: Escrow PDA is system-owned with zero data; lamports are managed via PDA signer.
    pub escrow: AccountInfo<'info>,
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

#[derive(Accounts)]
pub struct SettleSession<'info> {
    #[account(mut)]
    pub session: Account<'info, UsageSession>,
    #[account(mut, owner = anchor_lang::system_program::ID)]
    /// CHECK: Escrow PDA is system-owned with zero data; lamports are managed via PDA signer.
    pub escrow: AccountInfo<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub merchant: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct UsageSession {
    pub owner: Pubkey,
    pub service_id: Pubkey,
    pub unit: u8,
    pub decimals: u8,
    pub status: u8,
    pub bump: u8,
    pub escrow_bump: u8,
    pub deposit_lamports: u64,
    pub rate_lamports_per_unit: u64,
    pub merchant: Pubkey,
    pub total_usage: u64,
    pub settled_cost_lamports: u64,
    pub refunded_lamports: u64,
    pub last_event_ts: i64,
}

impl UsageSession {
    pub const SIZE: usize =
        8 + 32 + 32 + 1 + 1 + 1 + 1 + 1 + 8 + 8 + 32 + 8 + 8 + 8 + 8;
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
    #[msg("Invalid deposit amount")]
    InvalidDeposit,
    #[msg("Invalid rate amount")]
    InvalidRate,
    #[msg("Refund overflow")]
    RefundOverflow,
    #[msg("Invalid merchant account")]
    InvalidMerchant,
}
