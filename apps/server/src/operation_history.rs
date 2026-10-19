//! Owner-scoped keyset discovery. Summaries never include intent bodies, signing
//! bytes, calldata, idempotency keys or worker leases. Detail remains a separate read.
use crate::{
    error::AppError,
    identity::unavailable,
    work::{Operation, WorkStore, decode_operation},
};
use serde::Serialize;
use sqlx::Row;
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationListItem {
    pub operation: Operation,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationPage {
    pub items: Vec<OperationListItem>,
    /// The last returned operation ID, resolved inside this principal+wallet scope.
    /// Not a bearer credential. A foreign or nonexistent anchor is indistinguishable.
    pub next_cursor: Option<Uuid>,
}
impl WorkStore {
    #[tracing::instrument(name = "work.list", skip_all)]
    pub async fn list_operations(
        &self,
        user: Uuid,
        wallet: Uuid,
        cursor: Option<Uuid>,
        limit: u16,
    ) -> Result<OperationPage, AppError> {
        if !(1..=50).contains(&limit) {
            return Err(AppError::BadRequest(
                "operation page size must be 1 through 50".into(),
            ));
        }
        // Resolve the opaque anchor using full database timestamp precision. Never
        // round a pagination key through the millisecond timestamps shown in the UI.
        let rows = if let Some(cursor) = cursor {
            let created: time::OffsetDateTime = sqlx::query_scalar(
                "SELECT created_at FROM operations WHERE id=$1 AND user_id=$2 AND wallet_id=$3",
            )
            .bind(cursor)
            .bind(user)
            .bind(wallet)
            .fetch_optional(&self.pool)
            .await
            .map_err(unavailable)?
            .ok_or(AppError::NotFound)?;
            sqlx::query("SELECT id,wallet_id,action,state,version,(extract(epoch FROM created_at)*1000)::bigint AS created_at_ms,(extract(epoch FROM updated_at)*1000)::bigint AS updated_at_ms FROM operations WHERE user_id=$1 AND wallet_id=$2 AND (created_at,id)<($3,$4) ORDER BY created_at DESC,id DESC LIMIT $5")
                .bind(user).bind(wallet).bind(created).bind(cursor).bind(i64::from(limit)+1).fetch_all(&self.pool).await.map_err(unavailable)?
        } else {
            sqlx::query("SELECT id,wallet_id,action,state,version,(extract(epoch FROM created_at)*1000)::bigint AS created_at_ms,(extract(epoch FROM updated_at)*1000)::bigint AS updated_at_ms FROM operations WHERE user_id=$1 AND wallet_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3")
                .bind(user).bind(wallet).bind(i64::from(limit)+1).fetch_all(&self.pool).await.map_err(unavailable)?
        };
        let more = rows.len() > usize::from(limit);
        let items = rows
            .iter()
            .take(usize::from(limit))
            .map(|r| {
                Ok(OperationListItem {
                    operation: decode_operation(r)?,
                    created_at_ms: r.try_get("created_at_ms").map_err(unavailable)?,
                    updated_at_ms: r.try_get("updated_at_ms").map_err(unavailable)?,
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        let next_cursor = if more {
            items.last().map(|i| i.operation.id)
        } else {
            None
        };
        Ok(OperationPage { items, next_cursor })
    }
}
